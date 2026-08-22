import { randomUUID } from "node:crypto";
import {
  PLANNING_STAGE_RETRY_LIMIT,
  type Planner,
  type PlanningGenerationState,
  type PlanningMajorStage,
  type PlanningNodeId,
  type PlanningNodeState,
  type PlanningPlanV2,
  type PlanningPoiCandidate,
  type PlanningSkeleton,
  type ThreeStagePlanningAi,
} from "../../shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "./schemas.js";
import { runSingleStage } from "./single-stage-runner.js";
import type { OrchestratorRuntime } from "./types.js";
import { expandVerifiedItinerary, resolvePlanningPoiCandidates } from "./planning-v2-pois.js";
import type { PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { isAcceptablePlanningRegionName, isProvinceLevelName, normaliseProvinceName } from "./runtime.js";
import { findVbkCopyBadCase } from "./vbk-copy-policy.js";
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
    summary: "真实 POI、封面和用车资源已通过最终准入",
    error: undefined,
    completedAt: new Date().toISOString(),
  });
  plan = { ...plan, status: "completed", currentNode: "finalValidation" };
  await commit();
  return plan;
}

/** 第一阶段只补齐省份；城市在创建时锁定，AI 不得覆盖。 */
export async function runFoundationLocation(
  deps: ThreeStageOrchestratorDependencies,
  initial: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  getPlan: () => PlanningPlanV2,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  let previousError: { stage: "basicInfo"; attempt: number; code: string; message: string } | undefined;
  for (let attempt = 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    await patchNode("skeleton", { status: "running", attempts: attempt, startedAt: new Date().toISOString(), error: undefined });
    plan = getPlan();
    try {
      const currentProduct = await deps.runtime.loadCurrentProduct(deps.localProductId);
      const currentBasic = asRecord(currentProduct.basicInfo) ?? {};
      const currentCity = toPlatformShortLocationName(
        text(currentBasic.meetingCity) || text(currentBasic.destinationCity) || deps.skeleton.city,
      );
      const location = await deps.ai.structureLocation({
        destination: deps.skeleton.destination,
        currentProvince: text(currentBasic.province),
        currentDestinationCity: currentCity,
        previousError: previousError?.message,
      });
      const province = normaliseProvinceName(text(location.province));
      const errors: string[] = [];
      if (!province) errors.push("province 为空");
      else if (!isAcceptablePlanningRegionName(province, currentCity)) {
        errors.push(`province「${province}」不是可用的国家、地区或一级行政区名称`);
      }
      if (errors.length === 0) {
        const write = await deps.runtime.writeModule(
          deps.localProductId,
          "basicInfo",
          AI_WRITABLE_PATHS.basicInfo,
          { province },
        );
        if (!write.ok) throw new Error(write.reason || "标准目的地写入失败");
        deps.skeleton.province = province;
        deps.skeleton.city = currentCity;
        await patchNode("skeleton", {
          status: "completed",
          attempts: attempt,
          summary: `${province} · ${currentCity} · ${deps.skeleton.days}天`,
          error: undefined,
          completedAt: new Date().toISOString(),
        });
        return { ok: true, plan: getPlan() };
      }
      previousError = { stage: "basicInfo", attempt, code: "location_gate_failed", message: `第一阶段目的地准入失败：${errors.join("；")}` };
      await patchNode("skeleton", { status: "failed", attempts: attempt, error: previousError.message });
    } catch (error) {
      previousError = { stage: "basicInfo", attempt, code: "location_generation_failed", message: errorMessage(error) };
      await patchNode("skeleton", { status: "failed", attempts: attempt, error: previousError.message });
    }
    plan = getPlan();
  }
  return { ok: false, plan: await terminal(getPlan(), patchNode, "skeleton", previousError?.message ?? "第一阶段目的地准入失败") };
}
async function buildVerifiedPool(
  deps: ThreeStageOrchestratorDependencies,
  initial: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  getPlan: () => PlanningPlanV2,
  setPlan: (plan: PlanningPlanV2) => void,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  const hardMinimum = deps.skeleton.days;
  const target = Math.min(30, Math.max(10, deps.skeleton.days * 2));
  const recommendationTarget = Math.min(30, Math.max(10, deps.skeleton.days * 3));
  const pendingAtResume = plan.poiCandidates.filter((item) => item.status === "proposed");
  if (pendingAtResume.length > 0) {
    try {
      const checked = await resolvePlanningPoiCandidates({
        names: pendingAtResume.map((item) => item.requestedName), province: deps.skeleton.province,
        city: deps.skeleton.city, concurrency: 5, beforeEach: deps.assertVbkLogin, query: deps.queryPoi,
      });
      const byName = new Map(checked.map((item) => [item.requestedName, item]));
      plan = { ...plan, poiCandidates: plan.poiCandidates.map((item) => byName.get(item.requestedName) ?? item) };
      setPlan(plan);
      const hit = plan.poiCandidates.filter((item) => item.status === "resolved").length;
      await patchNode("poiResolution", { status: "completed", attempts: Math.max(1, node(plan, "poiResolution").attempts), summary: `推荐 ${plan.poiCandidates.length} / 命中 ${hit}`, error: undefined, completedAt: new Date().toISOString() });
      plan = getPlan();
    } catch (error) {
      await patchNode("poiResolution", { status: "blocked", attempts: node(plan, "poiResolution").attempts, error: errorMessage(error) });
      return { ok: false, plan: getPlan() };
    }
  }
  for (let round = node(plan, "spotCandidates").attempts + 1; round <= PLANNING_STAGE_RETRY_LIMIT; round += 1) {
    const resolved = plan.poiCandidates.filter((item) => item.status === "resolved");
    if (resolved.length >= target) break;
    const seen = plan.poiCandidates.map((item) => item.requestedName);
    await patchNode("spotCandidates", { status: "running", attempts: round, startedAt: new Date().toISOString(), error: undefined });
    plan = getPlan();
    let names: string[];
    try {
      names = await deps.ai.recommendSpotNames({
        destination: deps.skeleton.destination,
        province: deps.skeleton.province,
        city: deps.skeleton.city,
        days: deps.skeleton.days,
        targetCount: round === 1 ? recommendationTarget : Math.min(30 - seen.length, Math.max(1, target - resolved.length)),
        excludedNames: seen,
        rejectedNames: plan.poiCandidates.filter((item) => item.status === "rejected").map((item) => item.requestedName),
      });
    } catch (error) {
      const message = errorMessage(error);
      await patchNode("spotCandidates", { status: "failed", attempts: round, error: message });
      plan = getPlan();
      if (resolved.length >= hardMinimum) {
        // 已有候选足够支撑后续真实 POI 与行程准入时，模型补充推荐失败
        // 只是非阻断告警。后续节点成功后，不能把本轮暂时失败残留到最终规划树。
        await patchNode("spotCandidates", {
          status: "completed",
          attempts: round,
          summary: `已有 ${resolved.length} 个真实 POI，跳过本轮补充推荐`,
          error: undefined,
          completedAt: new Date().toISOString(),
        });
        plan = getPlan();
        break;
      }
      if (round === PLANNING_STAGE_RETRY_LIMIT) return { ok: false, plan: await terminal(plan, patchNode, "spotCandidates", message) };
      continue;
    }
    const newEntries = names.map((requestedName) => ({ requestedName, status: "proposed" as const }));
    plan = { ...getPlan(), poiCandidates: [...getPlan().poiCandidates, ...newEntries] };
    setPlan(plan);
    await patchNode("spotCandidates", { status: "completed", attempts: round, summary: `累计推荐 ${plan.poiCandidates.length} 个候选`, completedAt: new Date().toISOString() });
    plan = getPlan();

    const unresolved = plan.poiCandidates.filter((item) => item.status === "proposed");
    try {
      const checked = await resolvePlanningPoiCandidates({
        names: unresolved.map((item) => item.requestedName),
        province: deps.skeleton.province,
        city: deps.skeleton.city,
        concurrency: 5,
        beforeEach: deps.assertVbkLogin,
        query: deps.queryPoi,
      });
      const byName = new Map(checked.map((item) => [item.requestedName, item]));
      plan = {
        ...getPlan(),
        poiCandidates: getPlan().poiCandidates.map((item) => byName.get(item.requestedName) ?? item),
      };
      setPlan(plan);
      const hit = plan.poiCandidates.filter((item) => item.status === "resolved").length;
      await patchNode("poiResolution", {
        status: "completed",
        attempts: round,
        summary: `推荐 ${plan.poiCandidates.length} / 命中 ${hit}`,
        error: undefined,
        completedAt: new Date().toISOString(),
      });
      plan = getPlan();
    } catch (error) {
      const message = errorMessage(error);
      await patchNode("poiResolution", { status: "blocked", attempts: round - 1, error: message });
      return { ok: false, plan: getPlan() };
    }
  }
  const hit = plan.poiCandidates.filter((item) => item.status === "resolved").length;
  if (hit >= hardMinimum && node(plan, "spotCandidates").status === "failed") {
    // 续跑时可能在进入循环前就已经满足最低门槛，也要清理历史失败状态。
    await patchNode("spotCandidates", {
      status: "completed",
      summary: `已有 ${hit} 个真实 POI，满足最低准入门槛`,
      error: undefined,
      completedAt: new Date().toISOString(),
    });
    plan = getPlan();
  }
  if (hit < hardMinimum) {
    return { ok: false, plan: await terminal(plan, patchNode, "poiResolution", `真实 POI 仅 ${hit} 个，少于 ${hardMinimum} 天的最低门槛`) };
  }
  return { ok: true, plan };
}

async function composeItinerary(
  deps: ThreeStageOrchestratorDependencies,
  initial: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  getPlan: () => PlanningPlanV2,
  setPlan: (plan: PlanningPlanV2) => void,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  let previousError = node(plan, "itineraryDraft").error;
  const pool = plan.poiCandidates.filter((item): item is PlanningPoiCandidate & { poiId: number; poiName: string } =>
    item.status === "resolved" && Boolean(item.poiId && item.poiName));
  for (let attempt = node(plan, "itineraryDraft").attempts + 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    await patchNode("itineraryDraft", { status: "running", attempts: attempt, error: undefined, startedAt: new Date().toISOString() });
    try {
      const drafts = await deps.ai.composeVerifiedItinerary({
        destination: deps.skeleton.destination,
        days: deps.skeleton.days,
        candidates: pool,
        previousError,
      });
      const expanded = expandVerifiedItinerary({ drafts, pool, days: deps.skeleton.days });
      if (!expanded.ok) throw new Error(expanded.reason);
      const copyBadCase = findVbkCopyBadCase(expanded.itinerary, "itinerary");
      if (copyBadCase) {
        throw new Error(`行程文案命中 VBK 黑名单「${copyBadCase.term}」：${copyBadCase.reason}；请改写为「${copyBadCase.alternatives.join("」或「")}」`);
      }
      const write = await deps.runtime.writeModule(deps.localProductId, "itinerary", AI_WRITABLE_PATHS.itinerary, expanded.itinerary);
      if (!write.ok) throw new Error(write.reason || "行程写入失败");
      plan = {
        ...getPlan(),
        poiCandidates: getPlan().poiCandidates.map((item) => item.poiId && expanded.selectedIds.has(item.poiId)
          ? { ...item, status: "selected" as const }
          : item),
      };
      setPlan(plan);
      await patchNode("itineraryDraft", {
        status: "completed",
        attempts: attempt,
        summary: `采用 ${expanded.selectedIds.size} 个真实 POI，生成 ${deps.skeleton.days} 天行程`,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, plan: getPlan() };
    } catch (error) {
      previousError = errorMessage(error);
      await patchNode("itineraryDraft", { status: "failed", attempts: attempt, error: previousError });
      if (attempt === PLANNING_STAGE_RETRY_LIMIT) return { ok: false, plan: await terminal(getPlan(), patchNode, "itineraryDraft", previousError) };
    }
  }
  return { ok: false, plan };
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
