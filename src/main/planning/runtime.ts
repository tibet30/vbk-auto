/**
 * 把规划子系统接到现有 VbkDatabase 的胶水代码（barrel）：
 *   - DbGenerationStateStore：把 PlanningGenerationState 存到 planning_generation 表；
 *   - DbOrchestratorRuntime：写产品模块、添加 research tasks、读历史 / 产品快照、
 *     从持久化产品反推「哪个模块已落地」；
 *   - province-scope.ts：省级地名归一 + 省级目的地接受度 + 跨区 POI 主城市解析；
 *   - basic-merges.ts：basicInfo / presentation / skeleton（operations）写入前
 *     对象级 merge；alignProvinceLevelBasicCities：skeleton 写入后把省级
 *     destinationCity 同步到 pickupCity。
 *
 * 这里不包含 provider / model 判断；调用方在 main.ts 里根据 settings 决定
 * 使用哪个 adapter。
 */

import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import { ProductMutationService } from "../application/product-mutation-service.js";
import { getCtripSightAvailability, getCtripSightAvailabilities } from "../infrastructure/ctrip-sight-availability.js";
import { suggestPoi, suggestPoiDetail } from "../infrastructure/poi-suggest.js";
import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { applyProductPatchSafe } from "../operations/product-patch.js";
import { injectAccountButler } from "../operations/account-butler-inject.js";
import { applyManualReviewField } from "../operations/manual-review-field.js";
import { resolvePlanningPoiAutoSelection, type PoiAutoDisambiguator } from "./poi-auto-selection.js";
import { historicalConfirmedPoiId } from "./historical-poi-selection.js";
import { planningWriteContractError } from "./itinerary-input-contract.js";
import { extractLockedConstraints } from "../agent/prompt-helpers.js";
import type { TrafficLineConfig, TrafficLineEndpointAvailability } from "../../shared/contracts-traffic-line.js";
import type {
  GenerationStateStore,
  OrchestratorRuntime,
} from "./types.js";
import type {
  PlanningGenerationState,
  PlanningModule,
  ResearchTaskProposal,
} from "../../shared/contracts-planning.js";
import { detectAcceptedModulesFromProduct, itineraryPoisAreComplete } from "./runtime-accepted-modules.js";
import { isAcceptablePlanningRegionName, isProvinceLevelName, normaliseProvinceName, resolveTravelScope } from "./runtime/province-scope.js";
import {
  alignProvinceLevelBasicCities,
  mergeBasicInfo,
  mergePresentation,
  mergeSkeletonOperationsLocal,
  readValidProductButler,
} from "./runtime/basic-merges.js";

export {
  isAcceptablePlanningRegionName,
  isProvinceLevelName,
  normaliseProvinceName,
  resolveTravelScope,
} from "./runtime/province-scope.js";

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

export class DbOrchestratorRuntime implements OrchestratorRuntime {
  private readonly productMutations: ProductMutationService;

  constructor(
    private readonly db: VbkDatabase,
    private readonly browser?: VbkBrowser,
    productMutations?: ProductMutationService,
    private readonly runVbkPageExclusive?: <T>(task: () => Promise<T>) => Promise<T>,
    private readonly trafficLineAvailabilityResolver?: (localProductId: string) => Promise<TrafficLineEndpointAvailability | null>,
    private readonly poiDisambiguate?: PoiAutoDisambiguator,
  ) {
    this.productMutations = productMutations ?? new ProductMutationService(db);
  }
  async suggestPoi(keyword: string, context?: { destinationCity?: string; province?: string }) {
    if (!this.browser) return null;
    const query = async () => suggestPoi(await getVbkRequestPage(this.browser!), keyword, context);
    return this.runVbkPageExclusive ? this.runVbkPageExclusive(query) : query();
  }

  async resolvePoiSelection(localProductId: string, keyword: string, context?: { destinationCity?: string; province?: string }) {
    if (!this.browser) return { status: "uncertain" as const };
    const product = this.db.getProduct(localProductId);
    if (!product) return { status: "uncertain" as const };
    const query = async () => resolvePlanningPoiAutoSelection({
      localProductId,
      keyword,
      product: product.product,
      context,
      detail: await suggestPoiDetail(await getVbkRequestPage(this.browser!), keyword, context),
      confirmedPoiId: historicalConfirmedPoiId(this.db, product, keyword),
      checkAvailability: (poiId) => this.getPoiAvailability(poiId),
      disambiguate: this.poiDisambiguate,
    });
    return this.runVbkPageExclusive ? this.runVbkPageExclusive(query) : query();
  }

  async getPoiAvailability(poiId: number) {
    return getCtripSightAvailability(undefined, poiId, this.db);
  }

  async getPoiAvailabilities(poiIds: readonly number[]) {
    return getCtripSightAvailabilities(undefined, poiIds, this.db);
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
    if (module === "basicInfo") {
      const merged = mergeBasicInfo(product, value);
      value = merged.mergedValue;
    }
    if (module === "presentation") {
      const merged = mergePresentation(product, value);
      if (merged.rejectReason) return { ok: false, reason: merged.rejectReason };
      value = merged.mergedValue;
    }
    if (module === "skeleton") {
      value = mergeSkeletonOperationsLocal(product, value);
    }
    const contractError = planningWriteContractError(product, module, value);
    if (contractError) return { ok: false, reason: contractError };
    const result = applyProductPatchSafe(product.product, [
      { op: "replace", path: writePath, value },
    ]);
    if (!result.applied) return { ok: false, reason: "本地写入被拒（路径 / 值不合法）" };
    const productData = existingButler
      ? applyManualReviewField(result.product, { field: "butlerContact", selection: existingButler })
      : result.product;
    alignProvinceLevelBasicCities(productData, module, product.product);
    // Notify so workspace readiness refreshes after agent/planning module writes.
    this.productMutations.replace(localProductId, productData, {
      // 同日同名同类型的既有 POI 由统一写入口保留。规划模型重写文案时常会
      // 回传空 poiName/poiId；它不是显式取消已核验绑定的指令。
      // 改名、移除、类型转换或新的完整 POI 映射仍按传入值生效。
      preserveVerifiedItineraryPois: true,
    });
    const accountName = this.db.getSetting("vbkAccountName")?.value || null;
    injectAccountButler(this.db, localProductId, accountName);
    return { ok: true };
  }

  async writeResolvedItineraryPois(localProductId: string, itinerary: unknown[], previousItinerary: unknown[]) {
    const current = this.db.getProduct(localProductId);
    if (!current) return { ok: false, reason: "产品不存在" };
    if (JSON.stringify(current.product.itinerary) !== JSON.stringify(previousItinerary)) {
      return { ok: false, reason: "核验期间行程已变更，请按最新行程重试。" };
    }
    const reason = planningWriteContractError(current, "itinerary", itinerary);
    if (reason) return { ok: false, reason };
    this.productMutations.replace(localProductId, { ...current.product, itinerary }, {
      preserveVerifiedItineraryPois: false, expectedVersion: current.productJsonVersion ?? 0,
    });
    return { ok: true };
  }

  async writeResolvedHotelResources(localProductId: string, operations: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    const product = this.db.getProduct(localProductId);
    if (!product) return { ok: false, reason: "产品不存在" };
    const next = structuredClone(product.product);
    next.operations = operations;
    this.productMutations.replace(localProductId, next, { notify: false });
    return { ok: true };
  }

  async resolveTrafficLineAvailability(localProductId: string) {
    return this.trafficLineAvailabilityResolver?.(localProductId) ?? null;
  }

  async writeResolvedTrafficLineConfig(localProductId: string, config: TrafficLineConfig): Promise<{ ok: boolean; reason?: string }> {
    const product = this.db.getProduct(localProductId);
    if (!product) return { ok: false, reason: "产品不存在" };
    const next = structuredClone(product.product);
    const operations = next.operations && typeof next.operations === "object" && !Array.isArray(next.operations)
      ? next.operations as Record<string, unknown>
      : {};
    next.operations = { ...operations, trafficLine: structuredClone(config) };
    this.productMutations.replace(localProductId, next, { notify: false });
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