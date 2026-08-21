/**
 * 把规划子系统接到现有 VbkDatabase 的胶水代码。
 *
 *  - GenerationStateStore：把 PlanningGenerationState 存到 planning_generation 表。
 *  - OrchestratorRuntime：写产品模块、添加 research tasks、读历史 / 产品快照、
 *    从持久化产品反推「哪个模块已落地」。
 *
 *  这里不包含 provider / model 判断；调用方在 main.ts 里根据 settings 决定
 *  使用哪个 adapter。
 */

import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import { ProductMutationService } from "../application/product-mutation-service.js";
import { suggestPoi } from "../infrastructure/poi-suggest.js";
import { applyProductPatchSafe } from "../operations/product-patch.js";
import { injectAccountButler } from "../operations/account-butler-inject.js";
import { applyManualReviewField } from "../operations/manual-review-field.js";
import { RECOMMENDATION_CATEGORIES } from "../domain/product/recommendation-categories.js";
import type { ContactCardSelection } from "../../shared/contracts.js";
import type {
  GenerationStateStore,
  OrchestratorRuntime,
} from "./types.js";
import type {
  PlanningGenerationState,
  PlanningModule,
  ResearchTaskProposal,
} from "../../shared/contracts-planning.js";

export class DbGenerationStateStore implements GenerationStateStore {
  constructor(
    private readonly db: VbkDatabase,
    private readonly onSaved?: (state: PlanningGenerationState) => void,
  ) {}
  async load(localProductId: string): Promise<PlanningGenerationState | undefined> {
    return this.db.loadPlanningState(localProductId);
  }
  async save(state: PlanningGenerationState): Promise<void> {
    this.db.savePlanningState(state);
    this.onSaved?.(state);
  }
}

/**
 * 从持久化产品 JSON 反推「哪些模块已经落地」。
 *
 *  这是「真」的唯一来源；orchestrator 不依赖内存 accumulator。
 *
 *  - skeleton：operations.hotelTier / pickupCity / transport / mealsIncluded 都在；
 *  - presentation：对象存在 + recommendation + recommendations.length === 3 + 至少
 *    一条 category 命中白名单；
 *  - itinerary：数组非空 + 长度 = basicInfo.days + 每条 day 字段是 1..n 顺序递增
 *    + 每个 spot 都有平台 POI 映射（poiName + poiId）；
 *    旧浅实现只判断 length > 0，导致「2 天骨架 + 1 天行程」的非法产品被当作
 *    accepted 永久跳过，触发 false-success。骨架缺失时不放宽，仍然要求长度匹配；
 *  - packageName：commercial.packageName 非空；
 *  - pricing / inventory / release / terms：commercial.<key> 存在。
 */
export function detectAcceptedModulesFromProduct(product: Record<string, unknown>): PlanningModule[] {
  const accepted: PlanningModule[] = [];
  const basicInfo = product.basicInfo as Record<string, unknown> | undefined;
  if (basicInfo && typeof basicInfo.subtitle === "string" && basicInfo.subtitle.trim()
    && typeof basicInfo.province === "string" && basicInfo.province.trim()
    && typeof basicInfo.operationNotes === "string" && basicInfo.operationNotes.trim()) {
    accepted.push("basicInfo");
  }
  const operations = product.operations as Record<string, unknown> | undefined;
  if (
    operations
    && typeof operations === "object"
    && operations.hotelTier
    && operations.pickupCity
    && operations.transport
  ) {
    accepted.push("skeleton");
  }
  const presentation = product.presentation;
  if (presentation && typeof presentation === "object" && !Array.isArray(presentation)) {
    const p = presentation as Record<string, unknown>;
    if (typeof p.recommendation === "string" && p.recommendation.trim()
      && Array.isArray(p.recommendations) && p.recommendations.length === 3
      && typeof p.features === "string" && p.features.trim()
      && presentationRecommendationsValid(p.recommendations)) {
      accepted.push("presentation");
    }
  }
  const itinerary = product.itinerary;
  const expectedDays = Number.isInteger(Number(basicInfo?.days)) && Number(basicInfo?.days) > 0
    ? Number(basicInfo?.days)
    : null;
  if (Array.isArray(itinerary)) {
    if (expectedDays !== null) {
      if (itinerary.length === expectedDays && itineraryDaysAreOrdered(itinerary, expectedDays) && itineraryPoisAreComplete(itinerary)) {
        accepted.push("itinerary");
      }
    } else if (itinerary.length > 0 && itineraryDaysAreOrdered(itinerary, itinerary.length) && itineraryPoisAreComplete(itinerary)) {
      accepted.push("itinerary");
    }
  }
  const commercial = product.commercial as Record<string, unknown> | undefined;
  if (commercial && typeof commercial === "object") {
    if (typeof commercial.packageName === "string" && commercial.packageName.trim()) accepted.push("packageName");
    if (commercial.pricing && typeof commercial.pricing === "object" && !Array.isArray(commercial.pricing)) accepted.push("pricing");
    if (commercial.inventory && typeof commercial.inventory === "object" && !Array.isArray(commercial.inventory)) accepted.push("inventory");
    if (commercial.release && typeof commercial.release === "object" && !Array.isArray(commercial.release)) accepted.push("release");
  }
  return accepted;
}

/**
 * 验证 presentation.recommendations 三条都含合法 category / text：
 *   - 数组长度 = 3；
 *   - 每条 category 在 RECOMMENDATION_CATEGORIES 白名单里、text 非空；
 *   - 任何一条不合规 → 返回 false，整张 presentation 不算 accepted。
 */
function presentationRecommendationsValid(entries: unknown[]): boolean {
  let nonEmptyCategoryCount = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record.category !== "string" || !record.category.trim()) return false;
    if (!(RECOMMENDATION_CATEGORIES as readonly string[]).includes(record.category)) return false;
    if (typeof record.text !== "string" || !record.text.trim()) return false;
    nonEmptyCategoryCount += 1;
  }
  return nonEmptyCategoryCount === entries.length;
}

/**
 * 验证行程数组 days 字段是否 1..expectedDays 顺序递增且唯一：
 *   - 同时检查 record.day === index + 1，避免出现「2 天骨架 + 1 天行程」的非法产品；
 *   - 骨架缺失时不放宽（expectedDays==null 走调用方另一条分支）。
 */
function itineraryDaysAreOrdered(itinerary: unknown[], expectedDays: number): boolean {
  const seen = new Set<number>();
  for (let index = 0; index < expectedDays; index += 1) {
    const day = itinerary[index];
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    const record = day as Record<string, unknown>;
    const dayNum = Number(record.day);
    if (!Number.isInteger(dayNum) || dayNum < 1) return false;
    if (dayNum !== index + 1) return false;
    if (seen.has(dayNum)) return false;
    seen.add(dayNum);
  }
  return true;
}

export function itineraryPoisAreComplete(itinerary: unknown[]): boolean {
  if (itinerary.length === 0) return false;
  for (const day of itinerary) {
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    const spots = (day as Record<string, unknown>).spots;
    if (!Array.isArray(spots) || spots.length === 0) return false;
    for (const spot of spots) {
      if (!spot || typeof spot !== "object" || Array.isArray(spot)) return false;
      const record = spot as Record<string, unknown>;
      const poiName = typeof record.poiName === "string" ? record.poiName.trim() : "";
      const poiId = record.poiId;
      if (!poiName) return false;
      if (!(typeof poiId === "number" && Number.isInteger(poiId) && poiId > 0)) return false;
    }
  }
  return true;
}

function readValidProductButler(product: Record<string, unknown>): ContactCardSelection | null {
  const operations = product.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return null;
  const bookingControls = (operations as Record<string, unknown>).bookingControls;
  if (!bookingControls || typeof bookingControls !== "object" || Array.isArray(bookingControls)) return null;
  const butler = (bookingControls as Record<string, unknown>).butler;
  if (!butler || typeof butler !== "object" || Array.isArray(butler)) return null;
  const candidate = butler as Record<string, unknown>;
  const id = candidate.contactCardId;
  const providerId = candidate.providerId;
  const displayName = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  if (!Number.isInteger(id) || (id as number) <= 0) return null;
  if (!Number.isInteger(providerId) || (providerId as number) <= 0) return null;
  if (!displayName) return null;
  return { contactCardId: id as number, displayName, providerId: providerId as number };
}

/**
 * OrchestratorRuntime 的 SQLite 实现：
 *   - loadExistingResearchTasks：取产品下所有 research tasks，dedupe 按 label+type；
 *   - writeModule：applyProductPatchSafe 写入 product；
 *   - addResearchTask：委托 db.addResearchTask；
 *   - loadHistory / loadCurrentProduct / loadAcceptedModules：从持久化反推。
 */
export class DbOrchestratorRuntime implements OrchestratorRuntime {
  private readonly productMutations: ProductMutationService;

  constructor(
    private readonly db: VbkDatabase,
    private readonly browser?: VbkBrowser,
    productMutations?: ProductMutationService,
  ) {
    this.productMutations = productMutations ?? new ProductMutationService(db);
  }
  async suggestPoi(keyword: string, context?: { destinationCity?: string; province?: string }) {
    if (!this.browser) return null;
    return suggestPoi(await this.browser.page(), keyword, context);
  }

  async loadExistingResearchTasks(localProductId: string): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>> {
    const product = this.db.getProduct(localProductId);
    if (!product) return [];
    // 规划子系统使用「全状态」dedupe：confirmed / resolved 的运营 / VBK
    // 标记过的 research tasks 同样应当被视为已存在，避免下次 planning:start
    // 或 resume 时再次生成同 label+type 的重复任务。手动按钮调用走同一接口，
    // 与现有「重复添加视为同一任务」语义保持一致。
    return product.researchTasks.map((task) => ({ label: task.label, type: task.type }));
  }

  async writeModule(localProductId: string, module: PlanningModule, writePath: string, value: unknown): Promise<{ ok: boolean; reason?: string }> {
    const product = this.db.getProduct(localProductId);
    if (!product) return { ok: false, reason: "产品不存在" };
    const existingButler = readValidProductButler(product.product);
    // basicInfo is a shared object; replacing its root must preserve days/cities
    // and other existing fields needed by itinerary and automation.
    if (module === "basicInfo" && value && typeof value === "object" && !Array.isArray(value)) {
      const existing = product.product.basicInfo && typeof product.product.basicInfo === "object" && !Array.isArray(product.product.basicInfo)
        ? product.product.basicInfo as Record<string, unknown>
        : {};
      const incoming = { ...(value as Record<string, unknown>) };
      if (typeof incoming.province === "string") incoming.province = normaliseProvinceName(incoming.province);
      value = { ...existing, ...incoming };
    }
    if (module === "presentation" && value && typeof value === "object" && !Array.isArray(value)) {
      const existing = product.product.presentation && typeof product.product.presentation === "object" && !Array.isArray(product.product.presentation)
        ? product.product.presentation as Record<string, unknown>
        : {};
      value = { ...existing, ...(value as Record<string, unknown>) };
    }
    const result = applyProductPatchSafe(product.product, [
      { op: "replace", path: writePath, value },
    ]);
    if (!result.applied) return { ok: false, reason: "本地写入被拒（路径 / 值不合法）" };
    const productData = existingButler
      ? applyManualReviewField(result.product, { field: "butlerContact", selection: existingButler })
      : result.product;
    alignProvinceLevelBasicCities(productData, module, product.product);
    this.productMutations.replace(localProductId, productData, { notify: false });
    const accountName = this.db.getSetting("vbkAccountName")?.value || null;
    injectAccountButler(this.db, localProductId, accountName);
    return { ok: true };
  }

  async addResearchTask(localProductId: string, task: ResearchTaskProposal): Promise<string> {
    return this.db.addResearchTask(localProductId, task);
  }

  async loadHistory(localProductId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const product = this.db.getProduct(localProductId);
    if (!product) return [];
    return product.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => message.taskStatus !== "failed" && message.taskStatus !== "running")
      .slice(-12)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  }

  async loadCurrentProduct(localProductId: string): Promise<Record<string, unknown>> {
    const product = this.db.getProduct(localProductId);
    return product?.product ?? {};
  }

  async loadAcceptedModules(localProductId: string): Promise<PlanningModule[]> {
    const product = this.db.getProduct(localProductId);
    if (!product) return [];
    return detectAcceptedModulesFromProduct(product.product);
  }
}

function alignProvinceLevelBasicCities(
  productData: Record<string, unknown>,
  module: PlanningModule,
  previousProduct: Record<string, unknown>,
): void {
  if (module !== "skeleton") return;
  const basicInfo = productData.basicInfo;
  const operations = productData.operations;
  if (!basicInfo || typeof basicInfo !== "object" || Array.isArray(basicInfo)) return;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return;
  const basic = basicInfo as Record<string, unknown>;
  const ops = operations as Record<string, unknown>;
  const pickupCity = typeof ops.pickupCity === "string" ? ops.pickupCity.trim() : "";
  if (!pickupCity) return;
  const previousBasic = previousProduct.basicInfo;
  const previous = previousBasic && typeof previousBasic === "object" && !Array.isArray(previousBasic)
    ? previousBasic as Record<string, unknown>
    : {};
  const meetingCity = typeof previous.meetingCity === "string" ? previous.meetingCity.trim() : "";
  const destinationCity = typeof previous.destinationCity === "string" ? previous.destinationCity.trim() : "";
  if (isProvinceLevelName(meetingCity)) basic.meetingCity = pickupCity;
  if (isProvinceLevelName(destinationCity)) basic.destinationCity = pickupCity;
}

/** 统一省级名称展示：去除行政区后缀，保留已有简称（如“山西”“北京”）。 */
export function normaliseProvinceName(value: string): string {
  return value.trim().replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, "").trim();
}

/**
 * 判断一个名称是否本身就是省级行政区，而不是普通目的地城市。
 *
 * 规划输入允许用户直接写「内蒙古」或「内蒙古自治区」作为目的地；
 * 这类名称在 basicInfo 中会同时出现在 province / destinationCity，
 * 但不能因此被当作「把城市伪装成省份」而拒绝。
 */
const PROVINCE_LEVEL_NAMES = new Set([
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
  "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州",
  "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "香港", "澳门",
]);

export function isProvinceLevelName(value: string): boolean {
  return PROVINCE_LEVEL_NAMES.has(normaliseProvinceName(value));
}

const PROVINCE_TRAVEL_SCOPES: Record<string, { primaryCity: string; nearbyCoreCities: string[] }> = {
  北京: { primaryCity: "北京", nearbyCoreCities: [] },
  天津: { primaryCity: "天津", nearbyCoreCities: [] },
  上海: { primaryCity: "上海", nearbyCoreCities: [] },
  重庆: { primaryCity: "重庆", nearbyCoreCities: [] },
  河北: { primaryCity: "石家庄", nearbyCoreCities: ["正定"] },
  山西: { primaryCity: "太原", nearbyCoreCities: ["晋中"] },
  内蒙古: { primaryCity: "呼和浩特", nearbyCoreCities: ["包头"] },
  辽宁: { primaryCity: "沈阳", nearbyCoreCities: ["抚顺"] },
  吉林: { primaryCity: "长春", nearbyCoreCities: ["吉林市"] },
  黑龙江: { primaryCity: "哈尔滨", nearbyCoreCities: [] },
  江苏: { primaryCity: "南京", nearbyCoreCities: ["镇江", "扬州"] },
  浙江: { primaryCity: "杭州", nearbyCoreCities: ["绍兴"] },
  安徽: { primaryCity: "合肥", nearbyCoreCities: [] },
  福建: { primaryCity: "福州", nearbyCoreCities: ["泉州"] },
  江西: { primaryCity: "南昌", nearbyCoreCities: [] },
  山东: { primaryCity: "济南", nearbyCoreCities: ["泰安"] },
  河南: { primaryCity: "郑州", nearbyCoreCities: ["开封", "洛阳"] },
  湖北: { primaryCity: "武汉", nearbyCoreCities: [] },
  湖南: { primaryCity: "长沙", nearbyCoreCities: ["湘潭"] },
  广东: { primaryCity: "广州", nearbyCoreCities: ["佛山"] },
  广西: { primaryCity: "南宁", nearbyCoreCities: ["柳州"] },
  海南: { primaryCity: "海口", nearbyCoreCities: ["文昌"] },
  四川: { primaryCity: "成都", nearbyCoreCities: ["都江堰"] },
  贵州: { primaryCity: "贵阳", nearbyCoreCities: [] },
  云南: { primaryCity: "昆明", nearbyCoreCities: [] },
  西藏: { primaryCity: "拉萨", nearbyCoreCities: [] },
  陕西: { primaryCity: "西安", nearbyCoreCities: ["咸阳"] },
  甘肃: { primaryCity: "兰州", nearbyCoreCities: [] },
  青海: { primaryCity: "西宁", nearbyCoreCities: [] },
  宁夏: { primaryCity: "银川", nearbyCoreCities: [] },
  新疆: { primaryCity: "乌鲁木齐", nearbyCoreCities: [] },
  香港: { primaryCity: "香港", nearbyCoreCities: [] },
  澳门: { primaryCity: "澳门", nearbyCoreCities: [] },
};

export function resolveTravelScope(destination: string): { input: string; isProvinceLevel: boolean; primaryCity: string; nearbyCoreCities: string[] } {
  const input = destination.trim();
  const province = normaliseProvinceName(input);
  const scope = PROVINCE_TRAVEL_SCOPES[province];
  if (!scope) return { input, isProvinceLevel: false, primaryCity: input, nearbyCoreCities: [] };
  return { input, isProvinceLevel: true, primaryCity: scope.primaryCity, nearbyCoreCities: scope.nearbyCoreCities };
}
