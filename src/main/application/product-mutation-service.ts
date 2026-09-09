/**
 * 产品 JSON 的统一写入口。
 *
 * AI patch 必须在提交瞬间读取数据库最新快照后再应用，不能使用网络请求开始时
 * 的旧对象整包覆盖；所有写入完成后再从数据库读取 ProductDetail 并按需广播。
 */

import type { AiResponse, ProductDetail, ProductSummary } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { applyProductPatchSafe } from "../operations/product-patch.js";
import { normaliseProductLocationFields, toPlatformShortLocationName } from "../../shared/location-short-name.js";

type ProductMutationStore = Pick<VbkDatabase, "getProduct" | "updateProduct">;

export interface ProductMutationOptions {
  status?: ProductSummary["status"];
  notify?: boolean;
  /** 人工整包编辑可显式纠正历史错误城市；AI/规划写入仍锁定既有城市锚点。 */
  allowMeetingCityCorrection?: boolean;
  /**
   * 后台异步补全通常带着稍早的整包快照。保留当前已核验的 POI 绑定，
   * 防止封面、用车等无关写入把 poiName / poiId 回退为空。
   * 人工整包 JSON 编辑可显式关闭，保留人工清空或替换 POI 的权利。
   */
  preserveVerifiedItineraryPois?: boolean;
}

export class ProductMutationService {
  constructor(
    private readonly store: ProductMutationStore,
    private readonly onUpdated?: (product: ProductDetail) => void,
  ) {}

  replace(
    localProductId: string,
    product: Record<string, unknown>,
    options: ProductMutationOptions = {},
  ): ProductDetail {
    const current = this.store.getProduct(localProductId);
    if (!current) throw productNotFound(localProductId);
    const currentBasic = current.product.basicInfo && typeof current.product.basicInfo === "object"
      && !Array.isArray(current.product.basicInfo)
      ? current.product.basicInfo as Record<string, unknown>
      : {};
    const lockedMeetingCity = options.allowMeetingCityCorrection ? "" : toPlatformShortLocationName(
      typeof currentBasic.meetingCity === "string" && currentBasic.meetingCity.trim()
        ? currentBasic.meetingCity
        : currentBasic.destinationCity,
    );
    const incoming = options.preserveVerifiedItineraryPois === false
      ? product
      : preserveVerifiedItineraryPois(current.product, product);
    const normalised = normaliseProductLocationFields(incoming, lockedMeetingCity || undefined);
    this.store.updateProduct(localProductId, normalised, options.status);
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
      product: this.replace(localProductId, result.product, options),
      applied: true,
    };
  }
}

type JsonRecord = Record<string, unknown>;

/**
 * `replace` 接受的是完整产品快照，而封面/资源查询在网络往返期间可能已经过时。
 * 对同一天、同一原始景点，缺失的 incoming POI 不能抹掉已经由 VBK 核验过的绑定。
 * 新写入的完整绑定仍可覆盖旧绑定；不同景点也不会互相借用 POI。
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
    const verifiedByName = new Map<string, JsonRecord>();
    for (const spot of currentDay.spots) {
      if (!isRecord(spot) || !hasVerifiedPoi(spot)) continue;
      const name = text(spot.name);
      if (name) verifiedByName.set(name, spot);
    }
    for (const spot of incomingDay.spots) {
      if (!isRecord(spot) || hasVerifiedPoi(spot)) continue;
      const verified = verifiedByName.get(text(spot.name));
      if (!verified) continue;
      spot.poiName = verified.poiName;
      spot.poiId = verified.poiId;
      for (const field of ["province", "city", "district"] as const) {
        if (spot[field] === undefined && verified[field] !== undefined) spot[field] = verified[field];
      }
    }
  }
  return next;
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
