/**
 * 产品 JSON 的统一写入口。
 *
 * 提交流程上的不变量（详见 ARCHITECTURE.md §6「写入、并发与安全」）：
 *   1. 提交时读取最新产品，按字段与读取时的基线比较；
 *   2. 调用本服务执行城市、已核验 POI、人工删除与酒店一致性规则；
 *   3. 保存后重读，重读后的 ProductDetail 作为对外广播值。
 *
 * AI patch 必须在提交瞬间读取数据库最新快照后再应用，不能使用网络请求开始时
 * 的旧对象整包覆盖；所有写入完成后再从数据库读取 ProductDetail 并按需广播。
 *
 * 调用链：
 *   IPC handler
 *     ↓ createLocalProductState / workspace-snapshot ...
 *     ↓ ProductMutationService.{aiPatch, manualField, mergeChanges}
 *     ↓ ProductCommandService.{aiPatch, manualField}（source 来源校验）
 *     ↓ applyProductPatchSafe / applyManualReviewField（领域纯函数）
 *     ↓ store.replace + transaction + notify
 *
 * 跨进程广播：对其它观察者仍以 read-your-write + 冗余广播为原则；广播不在
 * 该层修复业务状态，那是 `ProductExecutionService` + 任务投影的职责。
 */

import type { AiResponse, ProductDetail, ProductSummary } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { applyProductPatchSafe } from "../operations/product-patch.js";
import { normaliseProductLocationFields, toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { preserveItineraryRemovals } from "../../shared/preserve-itinerary-removals.js";
import { preserveOperatorActivityKinds } from "../../shared/preserve-operator-itinerary-kinds.js";
import { inheritItinerarySpotIds, isItinerarySpotId, itinerarySpotExactName, itinerarySpotKey } from "../../shared/itinerary-spot-identity.js";
import { normaliseItinerarySupport } from "../../shared/itinerary-support-arrangements.js";
import { normaliseItineraryArrivalTitle } from "../../shared/itinerary-arrival-title.js";
import { normalisePlatformHotelProduct } from "../../shared/platform-hotel-rules.js";
import { ProductCommandService } from './product-command-service.js';
import { enforceReceiptedPoiBindings } from './itinerary-poi-binding-guard.js';

type ProductMutationStore = {
  runProductTransaction?: <T>(task: () => T) => T;
  markResearchTasksSatisfiedByProduct?: VbkDatabase['markResearchTasksSatisfiedByProduct'];
  reopenKindSupersededPoiResearchTasks?: VbkDatabase['reopenKindSupersededPoiResearchTasks'];
  confirmVerifiedPoiResearchTasks?: VbkDatabase['confirmVerifiedPoiResearchTasks'];
  getProduct: VbkDatabase["getProduct"];
  updateProduct: (
    id: string,
    product: Record<string, unknown>,
    status?: ProductSummary["status"],
    expectedVersion?: number,
    source?: string,
  ) => void;
};

export interface ProductMutationOptions {
  status?: ProductSummary["status"];
  notify?: boolean;
  /** 调用方持有的 product_json 版本；与库中不一致时拒绝覆盖。 */
  expectedVersion?: number;
  /** 人工整包编辑可显式纠正历史错误城市；AI/规划写入仍锁定既有城市锚点。 */
  allowMeetingCityCorrection?: boolean;
  /**
   * 后台异步补全通常带着稍早的整包快照。保留当前已核验的 POI 绑定，
   * 防止封面、用车等无关写入把 poiName / poiId 回退为空。
   * 人工整包 JSON 编辑可显式关闭，保留人工清空或替换 POI 的权利。
   */
  preserveVerifiedItineraryPois?: boolean;
  /** 仅人工整包编辑或明确的用户加回指令可以撤销删除凭证。 */
  allowItineraryRemovalRestore?: boolean;
  /**
   * AI patch 入口专用：本次写入新出现且没有受控凭证的 POI 绑定直接丢弃。
   * `patch_product` 的工具契约本就禁止携带 POI ID；落库前剥离才能让契约生效。
   * 规划模块写入（`writeModule`）不开这个开关，只记告警。
   */
  stripUnreceiptedPoi?: boolean;
  /**
   * 人工整包 JSON 编辑专用：新增的无凭证 POI 绑定直接拒绝保存。
   * 原始 JSON 不能创建凭证，静默保留只会留下「已绑定、任务不结清」，
   * 静默剥离又会丢掉运营刚写的内容，所以这里明确报错并要求走景点选择器。
   */
  rejectUnreceiptedPoi?: boolean;
  /** Set by the command service, never inferred from an active automation run. */
  source?: string;
}

export class ProductMutationService {
  readonly commands: ProductCommandService;
  constructor(
    private readonly store: ProductMutationStore,
    private readonly onUpdated?: (product: ProductDetail) => void,
  ) {
    this.commands = new ProductCommandService({
      getProduct: id => store.getProduct(id),
      replace: (id, product, options) => this.replace(id, product, options),
      transaction: task => store.runProductTransaction ? store.runProductTransaction(task) : task(),
      notify: product => onUpdated?.(product),
      satisfyResearch: store.markResearchTasksSatisfiedByProduct
        ? (id, product) => store.markResearchTasksSatisfiedByProduct!(id, product) : undefined,
      reopenResearch: store.reopenKindSupersededPoiResearchTasks
        ? (id, product) => { store.reopenKindSupersededPoiResearchTasks!(id, product); } : undefined,
      confirmPoiResearch: store.confirmVerifiedPoiResearchTasks
        ? (id, mappings) => store.confirmVerifiedPoiResearchTasks!(id, mappings) : undefined,
    });
  }

  replace(
    localProductId: string,
    product: Record<string, unknown>,
    options: ProductMutationOptions = {},
  ): ProductDetail {
    const current = this.store.getProduct(localProductId);
    if (!current) throw productNotFound(localProductId);
    if (options.expectedVersion !== undefined && (current.productJsonVersion ?? 0) !== options.expectedVersion) {
      throw new Error("产品内容已变更，请刷新后重试。");
    }
    const currentBasic = current.product.basicInfo && typeof current.product.basicInfo === "object"
      && !Array.isArray(current.product.basicInfo)
      ? current.product.basicInfo as Record<string, unknown>
      : {};
    const lockedMeetingCity = options.allowMeetingCityCorrection ? "" : toPlatformShortLocationName(
      typeof currentBasic.meetingCity === "string" && currentBasic.meetingCity.trim()
        ? currentBasic.meetingCity
        : currentBasic.destinationCity,
    );
    // 先按旧方案继承 spotId（模型输出不带 ID），后续 POI 保留与删除凭证都基于带 ID 的方案。
    const withIds = inheritItinerarySpotIds(current.product, product);
    // 人工把条目改成「自由活动 / 其他」后，生成重跑不得把它改回景点：类型凭证
    // 与删除凭证一样只认受控人工操作，人工整包编辑（source=user）仍然完全掌控。
    const withKinds = options.source === "user"
      ? withIds
      : preserveOperatorActivityKinds(current.product, withIds, current.researchTasks ?? []);
    const incoming = options.preserveVerifiedItineraryPois === false
      ? withKinds
      : preserveVerifiedItineraryPois(current.product, withKinds);
    const protectedIncoming = options.allowItineraryRemovalRestore ? incoming : preserveItineraryRemovals(current.product, incoming);
    // 统一写入口的护栏：新出现的 POI 绑定必须带当前槽位的受控凭证，否则该绑定
    // 永远不会结清「请手动选择 POI」决策门，运营会一直看到待核查项。
    const guarded = enforceReceiptedPoiBindings(current.product, protectedIncoming, {
      source: options.source ?? "user",
      strip: options.stripUnreceiptedPoi === true,
      localProductId,
    });
    if (options.rejectUnreceiptedPoi && guarded.recorded.length) {
      throw new Error(`行程 POI 绑定必须通过景点选择器保存：${guarded.recorded
        .map(binding => `第${binding.day}天「${binding.spotName}」→ ${binding.poiId}`)
        .join("；")}。请回到每日行程重新选择 POI，系统会自动写入受控凭证。`);
    }
    const normalised = normaliseItineraryArrivalTitle(normaliseProductLocationFields(guarded.product, lockedMeetingCity || undefined));
    if (Array.isArray(normalised.itinerary)) normalised.itinerary = normalised.itinerary.map((day) =>
      day && typeof day === "object" && !Array.isArray(day) ? normaliseItinerarySupport(day) : day);
    this.store.updateProduct(localProductId, normalisePlatformHotelProduct(normalised), options.status, current.productJsonVersion ?? 0, options.source);
    const saved = this.store.getProduct(localProductId);
    if (!saved) throw productNotFound(localProductId);
    if (options.notify !== false) this.onUpdated?.(saved);
    return saved;
  }

  applyAiPatch(
    localProductId: string,
    patch: NonNullable<AiResponse["patch"]>,
    options: ProductMutationOptions = {},
  ): { product: ProductDetail; applied: boolean } {
    const current = this.store.getProduct(localProductId);
    if (!current) throw productNotFound(localProductId);
    const result = applyProductPatchSafe(current.product, patch);
    if (!result.applied) return { product: current, applied: false };
    return {
      product: this.commands.mergeChanges(localProductId, current, result.product, 'ai',
        { ...options, stripUnreceiptedPoi: true }),
      applied: true,
    };
  }
}

type JsonRecord = Record<string, unknown>;

/**
 * `replace` 接受的是完整产品快照，而封面/资源查询在网络往返期间可能已经过时。
 * 对同一天、同一原始景点，缺失的 incoming POI 不能抹掉已经由 VBK 核验过的绑定。
 * 新写入的完整绑定仍可覆盖旧绑定；不同天、不同景点或活动类型变更都不会借用 POI。
 *
 * 景点匹配一对一：两侧都带 spotId 时只认 ID 相同的旧景点（且名称键、kind 仍须一致，
 * 改名即视为新景点）；任一侧缺 ID 时退回「同天 + 名称键 + kind」。
 * 每个旧的已核验景点最多被消耗一次，所以同天同名的多个景点不会共用一个 POI。
 */
function preserveVerifiedItineraryPois(current: JsonRecord, incoming: JsonRecord): JsonRecord {
  if (!Array.isArray(current.itinerary) || !Array.isArray(incoming.itinerary)) return incoming;
  const next = structuredClone(incoming) as JsonRecord;
  const currentDays = new Map<number, JsonRecord>();
  for (const day of current.itinerary) {
    if (!isRecord(day)) continue;
    const dayNumber = positiveDay(day.day);
    if (dayNumber !== null) currentDays.set(dayNumber, day);
  }

  for (const incomingDay of next.itinerary as unknown[]) {
    if (!isRecord(incomingDay)) continue;
    const currentDay = currentDays.get(positiveDay(incomingDay.day) ?? -1);
    if (!currentDay || !Array.isArray(currentDay.spots) || !Array.isArray(incomingDay.spots)) continue;
    const verified = currentDay.spots.filter((spot): spot is JsonRecord => isRecord(spot) && hasVerifiedPoi(spot));
    if (!verified.length) continue;
    const consumed = new Set<JsonRecord>();
    const incomingSpots = incomingDay.spots.filter(isRecord);
    // 先处理 ID 精确命中，避免缺 ID 的景点按名字抢走后面带 ID 景点的旧 POI。
    for (const spot of incomingSpots) {
      if (!isItinerarySpotId(spot.spotId)) continue;
      const match = verified.find(old => !consumed.has(old) && old.spotId === spot.spotId);
      // 同天另有名称键相同的景点（「X」与「X（夜景）」）时，ID 命中还须原名一致，
      // 否则 ID 可能是按名称键错配继承来的，POI 会串到别的景点上。
      if (match && sharesSpotKeyWithPeer(match, currentDay.spots, spot, incomingSpots)
        && itinerarySpotExactName(match.name) !== itinerarySpotExactName(spot.name)) continue;
      if (match && applyVerifiedPoi(spot, match)) consumed.add(match);
    }
    for (const spot of incomingSpots) {
      const hasId = isItinerarySpotId(spot.spotId);
      if (hasId && verified.some(old => old.spotId === spot.spotId)) continue;
      const match = verified.find(old => !consumed.has(old)
        // 本侧有 ID 时，只能退回到没有 ID 的旧景点；有别的 ID 的旧景点属于另一个槽位。
        && (!hasId || !isItinerarySpotId(old.spotId))
        && itinerarySpotKey(old.name) === itinerarySpotKey(spot.name));
      if (match && applyVerifiedPoi(spot, match)) consumed.add(match);
    }
  }
  return next;
}

/** 当前天或 incoming 天里，是否另有景点与这对景点名称键相同。 */
function sharesSpotKeyWithPeer(old: JsonRecord, currentSpots: unknown[], spot: JsonRecord, incomingSpots: JsonRecord[]): boolean {
  const keys = new Set([itinerarySpotKey(old.name), itinerarySpotKey(spot.name)]);
  return currentSpots.some(peer => isRecord(peer) && peer !== old && keys.has(itinerarySpotKey(peer.name)))
    || incomingSpots.some(peer => peer !== spot && keys.has(itinerarySpotKey(peer.name)));
}

/** 通过全部保护条件时把旧景点的 POI 绑定写入 incoming 景点；返回是否消耗了旧景点。 */
function applyVerifiedPoi(spot: JsonRecord, verified: JsonRecord): boolean {
  if (itinerarySpotKey(spot.name) !== itinerarySpotKey(verified.name)
    || !requiresItineraryPoi(spot)
    || !requiresItineraryPoi(verified)
    || activityKind(spot) !== activityKind(verified)) return false;
  if (hasVerifiedPoi(spot) && (spot.poiId !== verified.poiId || spot.poiName !== verified.poiName)) return false;
  spot.poiName = verified.poiName;
  spot.poiId = verified.poiId;
  for (const field of ["province", "city", "district"] as const) {
    if (spot[field] === undefined && verified[field] !== undefined) spot[field] = verified[field];
  }
  return true;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveDay(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function hasVerifiedPoi(spot: JsonRecord): boolean {
  return Boolean(text(spot.poiName))
    && typeof spot.poiId === "number"
    && Number.isInteger(spot.poiId)
    && spot.poiId > 0;
}

function activityKind(spot: JsonRecord): string {
  return text(spot.kind) || "attraction";
}
