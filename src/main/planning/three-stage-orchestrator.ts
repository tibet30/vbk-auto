import { randomUUID } from "node:crypto";
import {
  PLANNING_STAGE_RETRY_LIMIT,
  type Planner,
  type PlanningGenerationState,
  type PlanningMajorStage,
  type PlanningNodeId,
  type PlanningNodeState,
  type PlanningPlanV2,
  type PlanningSkeleton,
  type ThreeStagePlanningAi,
} from "../../shared/contracts-planning.js";
import { runSingleStage } from "./single-stage-runner.js";
import type { OrchestratorRuntime } from "./types.js";
import type { PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { isAcceptablePlanningRegionName, isProvinceLevelName, normaliseProvinceName } from "./runtime.js";
import { emptyPlanningUserIntent } from "../../shared/contracts-planning-intent.js";
import { buildVerifiedPool, composeItinerary, runFoundationLocation } from "./three-stage-itinerary-flow.js";
import { validateUserIntentDays } from "./user-intent.js";

export { runFoundationLocation };
export interface ThreeStageOrchestratorDependencies {
  localProductId: string;
  skeleton: PlanningSkeleton & { province: string; city: string };
  planner: Planner;
  ai: ThreeStagePlanningAi;
  runtime: OrchestratorRuntime;
  initialPlan?: PlanningPlanV2;
  persist(plan: PlanningPlanV2): Promise<void>;
  assertVbkLogin(): Promise<void>;
  queryPoi(name: string): Promise<PoiSuggestDetailResult>;
  resolveCover(): Promise<{ complete: boolean; summary: string }>;
  resolveVehicle(): Promise<{ complete: boolean; summary: string }>;
  privateTour: boolean;
  providerLabel?: string;
}
const NODE_DEFINITIONS: Array<[PlanningNodeId, PlanningMajorStage]> = [
  ["skeleton", "foundation"],
  ["spotCandidates", "itinerary"],
  ["poiResolution", "itinerary"],
  ["itineraryDraft", "itinerary"],
  ["copy", "completion"],
  ["presentation", "completion"],
  ["commercial", "completion"],
  ["cover", "completion"],
  ["vehicleResource", "completion"],
  ["finalValidation", "completion"],
];
export function createPlanningPlanV2(now = new Date().toISOString()): PlanningPlanV2 {
  return {
    version: 2,
    runId: randomUUID(),
    status: "pending",
    currentNode: "skeleton",
    nodes: NODE_DEFINITIONS.map(([id, majorStage]) => ({ id, majorStage, status: "pending", attempts: 0 })),
    poiCandidates: [],
    createdAt: now,
    updatedAt: now,
  };
}
export async function runThreeStagePlan(deps: ThreeStageOrchestratorDependencies): Promise<PlanningPlanV2> {
  let plan = normalisePlan(deps.initialPlan);
  let persistQueue = Promise.resolve();
  const commit = async () => {
    plan = { ...plan, updatedAt: new Date().toISOString(), nodes: [...plan.nodes], poiCandidates: [...plan.poiCandidates] };
    persistQueue = persistQueue.then(() => deps.persist(plan));
    await persistQueue;
  };
  const patchNode = async (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => {
    plan = {
      ...plan,
      currentNode: id,
      status: patch.status === "blocked" || patch.status === "failed" ? "needs_user" : "running",
      nodes: plan.nodes.map((node) => node.id === id ? { ...node, ...patch } : node),
    };
    await commit();
  };
  plan = { ...plan, status: "running" };
  await commit();
  const currentProduct = await deps.runtime.loadCurrentProduct(deps.localProductId);
  const currentBasic = asRecord(currentProduct.basicInfo);
  const userIdea = text(currentBasic.userIdea);
  deps.skeleton.city = toPlatformShortLocationName(
    text(currentBasic.meetingCity) || text(currentBasic.destinationCity) || deps.skeleton.city,
  );
  if (!isCompleted(plan, "skeleton") || !hasStandardLocation(deps.skeleton.province, deps.skeleton.city)) {
    const result = await runLegacyStage(deps, "skeleton", node(plan, "skeleton").attempts);
    if (result.status !== "completed") return failPlan(plan, patchNode, "skeleton", result.error);
    const location = await runFoundationLocation(deps, plan, patchNode, () => plan);
    if (!location.ok) return location.plan;
    plan = location.plan;
  }
  if (!plan.userIntent || plan.userIntent.rawIdea !== userIdea) {
    try {
      const userIntent = userIdea
        ? await deps.ai.structureUserIntent({ userIdea, destination: deps.skeleton.destination, days: deps.skeleton.days })
        : emptyPlanningUserIntent();
      const dayError = validateUserIntentDays(userIntent, deps.skeleton.days);
      if (dayError) return failPlan(plan, patchNode, "spotCandidates", dayError);
      plan = { ...plan, userIntent };
      await commit();
    } catch (error) {
      return failPlan(plan, patchNode, "spotCandidates", `用户想法解析失败：${errorMessage(error)}`);
    }
  }
  const itineraryReady = isCompleted(plan, "itineraryDraft");
  if (!itineraryReady) {
    const poolResult = await buildVerifiedPool(deps, plan, patchNode, () => plan, (next) => { plan = next; });
    if (!poolResult.ok) return poolResult.plan;
    plan = poolResult.plan;
    const itineraryResult = await composeItinerary(deps, plan, patchNode, () => plan, (next) => { plan = next; });
    if (!itineraryResult.ok) return itineraryResult.plan;
    plan = itineraryResult.plan;
  }
  // 基础文案同时提供目的地上下文和后续提示词所需的摘要。展示与商业节点
  // 都会写产品字段并触发远端整包持久化；必须先完成 presentation 的写入与
  // 持久化，再刷新 plan，最后启动 commercial，避免旧 presentation 快照在
  // commercial 的 packageName/pricing 等写回后覆盖新字段。
  if (!isCompleted(plan, "copy")) {
    await runCompletionAiNode(deps, plan, "copy", "basicInfo", patchNode);
    plan = { ...plan, nodes: [...plan.nodes] };
  }
  if (!isCompleted(plan, "presentation")) {
    await runCompletionAiNode(deps, plan, "presentation", "presentation", patchNode);
    plan = { ...plan, nodes: [...plan.nodes] };
  }
  if (!isCompleted(plan, "commercial")) {
    await runCompletionAiNode(deps, plan, "commercial", "commercial", patchNode);
    plan = { ...plan, nodes: [...plan.nodes] };
  }

  // 封面与用车查询都会驱动同一个 VBK BrowserView 导航，不能并行使用页面。
  // 两个节点仍各自保留 3 次重试，但资源查询本身必须串行，避免一个节点的
  // page.goto / page.evaluate 销毁另一个节点的执行上下文。
  plan = { ...plan, nodes: [...plan.nodes] };
  if (!isCompleted(plan, "cover")) {
    await runResourceNode(deps, plan, "cover", patchNode, deps.resolveCover);
    plan = { ...plan, nodes: [...plan.nodes] };
  }
  if (!isCompleted(plan, "vehicleResource") && node(plan, "vehicleResource").status !== "skipped") {
    if (deps.privateTour) {
      await runResourceNode(deps, plan, "vehicleResource", patchNode, deps.resolveVehicle);
    } else {
      await patchNode("vehicleResource", { status: "skipped", summary: "跟团游无需匹配私家团用车资源组", completedAt: new Date().toISOString() });
    }
  }
  const failed = plan.nodes.find((entry) => entry.majorStage === "completion" && (entry.status === "failed" || entry.status === "blocked"));
  if (failed) {
    plan = { ...plan, status: "needs_user", currentNode: failed.id };
    await commit();
    return plan;
  }
  const requiredComplete = ["copy", "presentation", "commercial", "cover"] as PlanningNodeId[];
  if (deps.privateTour) requiredComplete.push("vehicleResource");
  const missing = requiredComplete.filter((id) => !isCompleted(plan, id));
  if (missing.length > 0) return failPlan(plan, patchNode, "finalValidation", `产品补全节点未通过：${missing.join("、")}`);
  await patchNode("finalValidation", {
    status: "completed",
    attempts: node(plan, "finalValidation").attempts + 1,
    summary: "行程、封面和用车资源已完成规划检查；缺失 POI 需在自动录入前手动配置",
    error: undefined,
    completedAt: new Date().toISOString(),
  });
  plan = { ...plan, status: "completed", currentNode: "finalValidation" };
  await commit();
  return plan;
}

async function runCompletionAiNode(
  deps: ThreeStageOrchestratorDependencies,
  plan: PlanningPlanV2,
  id: "copy" | "presentation" | "commercial",
  stage: "basicInfo" | "presentation" | "commercial",
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
): Promise<void> {
  await patchNode(id, { status: "running", startedAt: new Date().toISOString(), error: undefined });
  const result = await runLegacyStage(deps, stage, node(plan, id).attempts);
  if (result.status === "completed") {
    const product = await deps.runtime.loadCurrentProduct(deps.localProductId);
    const missing = completionNodeMissingFields(stage, product);
    if (missing.length > 0) {
      await patchNode(id, {
        status: "failed",
        attempts: result.attempts,
        error: `${stage} 节点虽返回成功，但实际产品字段未落库：${missing.join("、")}`,
      });
      return;
    }
    await patchNode(id, { status: "completed", attempts: result.attempts, summary: stageSummary(stage), completedAt: new Date().toISOString() });
  } else {
    await patchNode(id, { status: "failed", attempts: result.attempts, error: result.error });
  }
}

function completionNodeMissingFields(
  stage: "basicInfo" | "presentation" | "commercial",
  product: Record<string, unknown>,
): string[] {
  if (stage === "basicInfo") {
    const basic = asRecord(product.basicInfo);
    return ["subtitle", "province", "destinationCity", "operationNotes"]
      .filter((field) => !text(asRecord(basic)?.[field]));
  }
  if (stage === "presentation") {
    const presentation = asRecord(product.presentation);
    return ["recommendation", "recommendations", "features"]
      .filter((field) => {
        const value = asRecord(presentation)?.[field];
        return field === "recommendations" ? !Array.isArray(value) || value.length !== 3 : !text(value);
      });
  }
  const commercial = asRecord(product.commercial);
  return ["packageName", "pricing", "inventory", "release"]
    .filter((field) => {
      const value = asRecord(commercial)?.[field];
      return field === "packageName" ? !text(value) : !asRecord(value);
    });
}

async function runResourceNode(
  deps: ThreeStageOrchestratorDependencies,
  plan: PlanningPlanV2,
  id: "cover" | "vehicleResource",
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  resolve: () => Promise<{ complete: boolean; summary: string }>,
): Promise<void> {
  let attempts = node(plan, id).attempts;
  for (let attempt = attempts + 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    try {
      await deps.assertVbkLogin();
    } catch (error) {
      await patchNode(id, { status: "blocked", attempts, error: errorMessage(error) });
      return;
    }
    attempts = attempt;
    await patchNode(id, { status: "running", attempts, error: undefined, startedAt: new Date().toISOString() });
    try {
      const outcome = await resolve();
      if (!outcome.complete) throw new Error(outcome.summary);
      await patchNode(id, { status: "completed", attempts, summary: outcome.summary, completedAt: new Date().toISOString() });
      return;
    } catch (error) {
      await patchNode(id, { status: "failed", attempts, error: errorMessage(error) });
    }
  }
}

async function runLegacyStage(
  deps: ThreeStageOrchestratorDependencies,
  stage: "skeleton" | "basicInfo" | "presentation" | "commercial",
  existingAttempts: number,
): Promise<{ status: string; attempts: number; error: string }> {
  if (existingAttempts >= PLANNING_STAGE_RETRY_LIMIT) {
    return { status: "needs_user", attempts: existingAttempts, error: `${stage} 已达到 3 次尝试上限` };
  }
  const state: PlanningGenerationState = {
    localProductId: deps.localProductId,
    currentStage: stage,
    completedStages: [],
    stages: [],
    status: "running",
    resumeAt: new Date().toISOString(),
    providerLabel: deps.providerLabel,
  };
  const result = await runSingleStage({
    stage,
    state,
    skeleton: deps.skeleton,
    planner: deps.planner,
    runtime: deps.runtime,
    retryLimit: stage === "skeleton" ? 1 : PLANNING_STAGE_RETRY_LIMIT - existingAttempts,
    history: await deps.runtime.loadHistory(deps.localProductId),
    existingTasks: await deps.runtime.loadExistingResearchTasks(deps.localProductId),
    providerLabel: deps.providerLabel,
  });
  const persisted = result.state.stages.find((entry) => entry.stage === stage);
  return {
    status: result.status,
    attempts: stage === "skeleton" ? Math.max(1, existingAttempts) : existingAttempts + (persisted?.attempts ?? 0),
    error: persisted?.lastError?.message || result.rejected.map((entry) => entry.reason).filter(Boolean).join("；") || `${stage} 未通过准入`,
  };
}

function normalisePlan(plan?: PlanningPlanV2): PlanningPlanV2 {
  if (!plan || plan.version !== 2) return createPlanningPlanV2();
  const byId = new Map(plan.nodes.map((entry) => [entry.id, entry]));
  return {
    ...plan,
    nodes: NODE_DEFINITIONS.map(([id, majorStage]) => byId.get(id) ?? { id, majorStage, status: "pending", attempts: 0 }),
    poiCandidates: Array.isArray(plan.poiCandidates) ? plan.poiCandidates : [],
  };
}

function node(plan: PlanningPlanV2, id: PlanningNodeId): PlanningNodeState {
  return plan.nodes.find((entry) => entry.id === id)!;
}

function isCompleted(plan: PlanningPlanV2, id: PlanningNodeId): boolean {
  const status = node(plan, id).status;
  return status === "completed" || status === "skipped";
}

async function terminal(
  plan: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  id: PlanningNodeId,
  error: string,
): Promise<PlanningPlanV2> {
  await patchNode(id, { status: "failed", error });
  return { ...plan, status: "needs_user", currentNode: id };
}

async function failPlan(
  plan: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  id: PlanningNodeId,
  error: string,
): Promise<PlanningPlanV2> {
  await patchNode(id, { status: "failed", error });
  return { ...plan, status: "needs_user", currentNode: id };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasStandardLocation(province: string, city: string): boolean {
  return Boolean(province && isAcceptablePlanningRegionName(province, city) && isValidDestinationCity(city, normaliseProvinceName(province)));
}

function isValidDestinationCity(city: string, province: string): boolean {
  const value = city.trim();
  if (!value || value.length > 40 || /\d/.test(value)) return false;
  if (!isProvinceLevelName(value)) return true;
  return ["北京", "天津", "上海", "重庆", "香港", "澳门"].includes(normaliseProvinceName(province))
    && normaliseProvinceName(value) === normaliseProvinceName(province);
}

function stageSummary(stage: string): string {
  if (stage === "basicInfo") return "副标题与 Operation Notes 已生成";
  if (stage === "presentation") return "推荐语、3 条推荐理由、分类与卖点已生成";
  return "套餐名、价格、库存与草稿 Release 已生成";
}
