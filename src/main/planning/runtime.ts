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
import { suggestPoi } from "../infrastructure/poi-suggest.js";
import { applyProductPatchSafe } from "../operations/product-patch.js";
import { RECOMMENDATION_CATEGORIES } from "../automation/schema/schema-definitions.js";
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
  async load(projectId: string): Promise<PlanningGenerationState | undefined> {
    return this.db.loadPlanningState(projectId);
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
 *  - itinerary：数组非空 + 长度 = basicInfo.days + 每条 day 字段是 1..n 顺序递增；
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
      if (itinerary.length === expectedDays && itineraryDaysAreOrdered(itinerary, expectedDays)) {
        accepted.push("itinerary");
      }
    } else if (itinerary.length > 0 && itineraryDaysAreOrdered(itinerary, itinerary.length)) {
      accepted.push("itinerary");
    }
  }
  const commercial = product.commercial as Record<string, unknown> | undefined;
  if (commercial && typeof commercial === "object") {
    if (typeof commercial.packageName === "string" && commercial.packageName.trim()) accepted.push("packageName");
    if (commercial.pricing && typeof commercial.pricing === "object" && !Array.isArray(commercial.pricing)) accepted.push("pricing");
    if (commercial.inventory && typeof commercial.inventory === "object" && !Array.isArray(commercial.inventory)) accepted.push("inventory");
    if (commercial.terms && typeof commercial.terms === "object" && !Array.isArray(commercial.terms)) accepted.push("terms");
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

/**
 * OrchestratorRuntime 的 SQLite 实现：
 *   - loadExistingResearchTasks：取项目下所有 research tasks，dedupe 按 label+type；
 *   - writeModule：applyProductPatchSafe 写入 product；
 *   - addResearchTask：委托 db.addResearchTask；
 *   - loadHistory / loadCurrentProduct / loadAcceptedModules：从持久化反推。
 */
export class DbOrchestratorRuntime implements OrchestratorRuntime {
  constructor(private readonly db: VbkDatabase, private readonly browser?: VbkBrowser) {}
  async suggestPoi(keyword: string) {
    if (!this.browser) return null;
    return suggestPoi(await this.browser.page(), keyword);
  }

  async loadExistingResearchTasks(projectId: string): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>> {
    const project = this.db.getProject(projectId);
    if (!project) return [];
    // 规划子系统使用「全状态」dedupe：confirmed / resolved 的运营 / VBK
    // 标记过的 research tasks 同样应当被视为已存在，避免下次 planning:start
    // 或 resume 时再次生成同 label+type 的重复任务。手动按钮调用走同一接口，
    // 与现有「重复添加视为同一任务」语义保持一致。
    return project.researchTasks.map((task) => ({ label: task.label, type: task.type }));
  }

  async writeModule(projectId: string, module: PlanningModule, writePath: string, value: unknown): Promise<{ ok: boolean; reason?: string }> {
    const project = this.db.getProject(projectId);
    if (!project) return { ok: false, reason: "项目不存在" };
    // basicInfo is a shared object; replacing its root must preserve days/cities
    // and other existing fields needed by itinerary and automation.
    if (module === "basicInfo" && value && typeof value === "object" && !Array.isArray(value)) {
      const existing = project.product.basicInfo && typeof project.product.basicInfo === "object" && !Array.isArray(project.product.basicInfo)
        ? project.product.basicInfo as Record<string, unknown>
        : {};
      const incoming = { ...(value as Record<string, unknown>) };
      if (typeof incoming.province === "string") incoming.province = normaliseProvinceName(incoming.province);
      if (typeof existing.province === "string" && existing.province.trim()) delete incoming.province;
      value = { ...existing, ...incoming };
    }
    const result = applyProductPatchSafe(project.product, [
      { op: "replace", path: writePath, value },
    ]);
    if (!result.applied) return { ok: false, reason: "本地写入被拒（路径 / 值不合法）" };
    this.db.updateProduct(projectId, result.product);
    return { ok: true };
  }

  async addResearchTask(projectId: string, task: ResearchTaskProposal): Promise<string> {
    return this.db.addResearchTask(projectId, task);
  }

  async loadHistory(projectId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const project = this.db.getProject(projectId);
    if (!project) return [];
    return project.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => message.taskStatus !== "failed" && message.taskStatus !== "running")
      .slice(-12)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  }

  async loadCurrentProduct(projectId: string): Promise<Record<string, unknown>> {
    const project = this.db.getProject(projectId);
    return project?.product ?? {};
  }

  async loadAcceptedModules(projectId: string): Promise<PlanningModule[]> {
    const project = this.db.getProject(projectId);
    if (!project) return [];
    return detectAcceptedModulesFromProduct(project.product);
  }
}

/** 统一省级名称展示：去除行政区后缀，保留已有简称（如“山西”“北京”）。 */
export function normaliseProvinceName(value: string): string {
  return value.trim().replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, "").trim();
}
