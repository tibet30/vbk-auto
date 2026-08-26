/** 单阶段执行器：推进 planner / runtime 输入到下一阶段。 */

import { AI_WRITABLE_PATHS } from "./schemas.js";
import { STAGE_ALLOWED_MODULES } from "./stage-contract.js";
import { executeStageOutput, upsertStageInState, toStageError } from "./stage-runner.js";
import { validateCompleteness, deepValidateModules } from "./validation.js";
import { composeStageAssistantReply } from "./replies.js";
import { pendingResearchTasks } from "./research-tasks.js";
import { enrichItineraryPois } from "./poi-enrichment.js";
import { buildRewoundState } from "./validation-rewind.js";
import { logAttemptError, logNoProgress, logStageEnd, logStageStart } from "./log.js";
import type { ModuleOutcome, Planner, PlannerContext, PlanningGenerationState, PlanningModule, PlanningStage, PlanningStageError, ResearchTaskProposal, PlanningSkeleton } from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";
import { logInfo } from "../../shared/log-timestamp.js";
import { resolveTravelScope } from "./runtime.js";
import { ensurePackageName, normaliseCommercialOutcomes } from "./commercial-stage.js";
import { ensurePresentationCover } from "./cover-default.js";

export interface SingleStageResult {
  state: PlanningGenerationState;
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: ResearchTaskProposal[];
  status: "running" | "needs_user" | "completed" | "failed";
  assistantReply: string;
}

export interface RunSingleStageArgs {
  stage: PlanningStage;
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  planner: Planner;
  runtime: OrchestratorRuntime;
  retryLimit: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  existingTasks: Array<Pick<ResearchTaskProposal, "label" | "type">>;
  providerLabel?: string;
}

export async function runSingleStage(args: RunSingleStageArgs): Promise<SingleStageResult> {
  const { stage, state, skeleton, planner, runtime, retryLimit, history, existingTasks } = args;
  const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  let attempts = state.stages.find((s) => s.stage === stage)?.attempts ?? 0;
  let lastError: PlanningStageError | undefined;
  logStageStart("进入阶段", { stage, localProductId: state.localProductId, attempts });

  if (stage === "skeleton") {
    return await runSkeletonStage({ state, skeleton, runtime, attempts, lastError });
  }

  if (stage === "validation") {
    return await runValidationStage({ state, skeleton, runtime, attempts, lastError });
  }

  if (stage === "research") {
    return await runResearchStage({ state, skeleton, runtime, existingTasks, attempts, lastError });
  }

  return await runAiStage({
    stage, state, skeleton, planner, runtime, retryLimit, history, existingTasks, providerLabel: args.providerLabel,
    allowed, accepted, rejected, researchTasks, attempts, lastError,
  });
}

async function runSkeletonStage(args: {
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
  attempts: number;
  lastError: PlanningStageError | undefined;
}): Promise<SingleStageResult> {
  const { state, skeleton, runtime, attempts, lastError } = args;
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  const alreadyAccepted = await runtime.loadAcceptedModules(state.localProductId);
  if (alreadyAccepted.includes("skeleton")) {
    accepted.push({ module: "skeleton", status: "accepted", writePath: AI_WRITABLE_PATHS.skeleton, acceptedFields: ["hotelTier", "pickupCity", "transport"] });
    return makeStageResult({ state, stage: "skeleton", accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
  }
  if (!alreadyAccepted.includes("skeleton")) {
    const travelScope = resolveTravelScope(skeleton.destination);
    const result = await runtime.writeModule(state.localProductId, "skeleton", AI_WRITABLE_PATHS.skeleton, {
      hotelTier: skeleton.productForm === "privateTour" ? "当地5钻酒店/-38" : "当地3钻酒店/-3",
      pickupCity: travelScope.primaryCity,
      transport: "charter",
      reusePickupForDropoff: true,
      mealsIncluded: false,
    });
    if (!result.ok) {
      rejected.push({ module: "skeleton", status: "rejected", reason: result.reason || "骨架写入失败" });
      return makeStageResult({ state, stage: "skeleton", accepted, rejected, researchTasks, attempts, lastError, status: "failed" });
    }
    accepted.push({ module: "skeleton", status: "accepted", writePath: AI_WRITABLE_PATHS.skeleton, acceptedFields: ["hotelTier", "pickupCity", "transport"] });
  }
  return makeStageResult({ state, stage: "skeleton", accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
}

async function runValidationStage(args: {
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
  attempts: number;
  lastError: PlanningStageError | undefined;
}): Promise<SingleStageResult> {
  const { state, skeleton, runtime, attempts, lastError } = args;
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  const acceptedFromProduct = await runtime.loadAcceptedModules(state.localProductId);
  const validation = validateCompleteness({ acceptedModules: acceptedFromProduct });
  for (const m of validation.accepted) accepted.push(m);
  for (const m of validation.missing) rejected.push(m);
  const product = await runtime.loadCurrentProduct(state.localProductId);
  const deep = deepValidateModules({
    skeleton,
    product,
    acceptedModules: acceptedFromProduct,
  });
  for (const inv of deep.invalid) rejected.push(inv);
  let stateAfter = { ...state, stages: upsertStageInState(state, "validation", { accepted, rejected, attempts, lastError, updatedAt: now() }) };
  if (deep.invalid.length > 0) {
    stateAfter = buildRewoundState({ state: stateAfter, invalid: deep.invalid });
  }
  return {
    state: stateAfter,
    accepted,
    rejected,
    researchTasks,
    status: validation.complete && deep.invalid.length === 0 ? "completed" : "needs_user",
    assistantReply: composeStageAssistantReply("validation", accepted, rejected),
  };
}

async function runResearchStage(args: {
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
  existingTasks: Array<Pick<ResearchTaskProposal, "label" | "type">>;
  attempts: number;
  lastError: PlanningStageError | undefined;
}): Promise<SingleStageResult> {
  const { state, skeleton, runtime, existingTasks, attempts, lastError } = args;
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  const acceptedFromProduct = await runtime.loadAcceptedModules(state.localProductId);
  const coverOutcome = await ensurePresentationCover({ localProductId: state.localProductId, runtime });
  if (coverOutcome?.status === "accepted") accepted.push(coverOutcome);
  if (coverOutcome?.status === "rejected") rejected.push(coverOutcome);
  const product = await runtime.loadCurrentProduct(state.localProductId);
  const pending = pendingResearchTasks({
    skeleton,
    product,
    acceptedModules: acceptedFromProduct,
    existing: existingTasks,
  });
  for (const entry of pending) {
    await runtime.addResearchTask(state.localProductId, entry.proposal);
    researchTasks.push(entry.proposal);
  }
  const stageOutcome: ModuleOutcome = {
    module: "researchTasks",
    status: "accepted",
    researchTasks: pending.map((p) => p.proposal),
    acceptedFields: ["researchTasks"],
  };
  accepted.push(stageOutcome);
  return {
    state: { ...state, stages: upsertStageInState(state, "research", { accepted, rejected, attempts, lastError, updatedAt: now() }) },
    accepted,
    rejected,
    researchTasks,
    status: "completed",
    assistantReply: composeStageAssistantReply("research", accepted, rejected),
  };
}

/**
 * makeStageResult 的输入：除 accepted/rejected/researchTasks 外还要 stage / attempts / lastError / status，
 * 用于组装完整的 SingleStageResult。
 */
interface MakeStageResultArgs {
  state: PlanningGenerationState;
  stage: PlanningStage;
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: ResearchTaskProposal[];
  attempts: number;
  lastError: PlanningStageError | undefined;
  status: "running" | "needs_user" | "completed" | "failed";
}

/**
 * 组装阶段结果：
 *   - 修正 currentStage：上一轮残留的 currentStage 与本轮失败 stage 不一致时校正；
 *   - 写回 accepted / rejected / attempts / lastError / status；
 *   - 用 composeStageAssistantReply 生成给用户的中文 assistant 文案。
 */
function makeStageResult(args: MakeStageResultArgs): SingleStageResult {
  const outcomes = normaliseStageOutcomes(args.stage, args.accepted, args.rejected);
  // currentStage 保留失败 stage（让用户看到「卡在哪」）；resume 由
  // plan-orchestrator 的 skip 逻辑跳过已完成的 stage，从 currentStage 起跑。
  // 只在 needs_user / failed 时把 currentStage 校正为本次失败的 stage，
  // 防止上一轮 needs_user 留下的 currentStage 与本次失败的 stage 不一致
  // 导致用户看到「currentStage=skeleton 但实际跑的是 itinerary」的怪现象。
  const currentStage = args.state.currentStage === args.stage || args.state.completedStages.includes(args.state.currentStage)
    ? args.state.currentStage
    : args.stage;
  const stateAfter = {
    ...args.state,
    status: args.status,
    currentStage,
    stages: upsertStageInState(args.state, args.stage, { accepted: outcomes.accepted, rejected: outcomes.rejected, attempts: args.attempts, lastError: args.lastError, updatedAt: now() }),
  };
  return {
    state: stateAfter,
    accepted: outcomes.accepted,
    rejected: outcomes.rejected,
    researchTasks: args.researchTasks,
    status: args.status,
    assistantReply: composeStageAssistantReply(args.stage, outcomes.accepted, outcomes.rejected),
  };
}

function normaliseStageOutcomes(
  stage: PlanningStage,
  accepted: ModuleOutcome[],
  rejected: ModuleOutcome[],
): { accepted: ModuleOutcome[]; rejected: ModuleOutcome[] } {
  if (stage !== "commercial") return { accepted, rejected };
  return normaliseCommercialOutcomes(accepted, rejected);
}

/**
 * AI 阶段的通用重试循环：
 *   - 维护 stageAcceptedModules（commercial 阶段专用）；
 *   - 单模块阶段（itinerary/presentation）若已 accepted，直接跳出；
 *   - planner.generateStage → executeStageOutput；失败重试 retryLimit 次；
 *   - 全部 retry 用完仍无 accepted → needs_user 或 failed（取决于错误码）。
 */
async function runAiStage(args: {
  stage: PlanningStage;
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  planner: Planner;
  runtime: OrchestratorRuntime;
  retryLimit: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  existingTasks: Array<Pick<ResearchTaskProposal, "label" | "type">>;
  providerLabel?: string;
  allowed: readonly PlanningModule[];
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: ResearchTaskProposal[];
  attempts: number;
  lastError: PlanningStageError | undefined;
}): Promise<SingleStageResult> {
  const { stage, state, skeleton, planner, runtime, retryLimit, history, existingTasks, allowed, providerLabel } = args;
  let accepted = args.accepted;
  let rejected = args.rejected;
  let researchTasks = args.researchTasks;
  let attempts = args.attempts;
  let lastError = args.lastError;
  const persistedTaskKeys = new Set(existingTasks.map((task) => `${task.type}::${task.label}`));

  if (stage === "commercial") {
    const packageNameResult = await ensurePackageName({ state, skeleton, runtime });
    if (!packageNameResult.ok) {
      rejected.push({ module: "packageName", status: "rejected", reason: packageNameResult.reason });
      lastError = { stage, attempt: attempts, code: "missing_module", message: packageNameResult.reason };
      return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status: "needs_user" });
    }
    if (packageNameResult.outcome) accepted.push(packageNameResult.outcome);
  }

  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    attempts = attempt;
    // commercial 阶段：维护「已 accepted 模块集合」，重试只补缺失模块；已接受的模块
    // 不再要求 AI 重发，避免覆盖已落地的合法数据。
    const stageAcceptedModules = stage === "commercial"
      ? new Set<PlanningModule>()
      : undefined;
    if (stage === "commercial") {
      const already = await runtime.loadAcceptedModules(state.localProductId);
      for (const m of already) {
        if ((STAGE_ALLOWED_MODULES.commercial as readonly PlanningModule[]).includes(m)) {
          stageAcceptedModules!.add(m);
          accepted.push({
            module: m,
            status: "accepted",
            writePath: AI_WRITABLE_PATHS[m] ?? undefined,
            acceptedFields: [],
          });
        }
      }
    }
    // 单模块阶段（itinerary / presentation）：如果持久化产品已经有 valid 模块，跳过整次 AI 调用。
    if (stage === "itinerary" || stage === "presentation") {
      const alreadyAccepted = await runtime.loadAcceptedModules(state.localProductId);
      const sole = stage === "itinerary" ? "itinerary" : "presentation";
      if (alreadyAccepted.includes(sole)) {
        if (stage === "itinerary") logInfo("[planning.poi]", { event: "skip", localProductId: state.localProductId });
        accepted.push({
          module: sole,
          status: "accepted",
          writePath: AI_WRITABLE_PATHS[sole],
          acceptedFields: [],
        });
        return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
      }
    }
    const ctx: PlannerContext = {
      skeleton,
      currentProduct: await runtime.loadCurrentProduct(state.localProductId),
      acceptedModules: accepted.map((m) => ({
        module: m.module,
        status: "accepted",
        writePath: m.writePath,
        acceptedFields: m.acceptedFields,
        missingFields: m.missingFields,
        updatedAt: now(),
      })),
      existingResearchTasks: existingTasks,
      history,
      transport: { providerLabel: providerLabel ?? "ai", model: "" },
    };
    try {
      const output = await planner.generateStage({
        stage,
        context: ctx,
        previousError: lastError,
      });
      const exec = await executeStageOutput({ stage, output, runtime, localProductId: state.localProductId });
      for (const m of exec.accepted) {
        accepted.push(m);
        stageAcceptedModules?.add(m.module);
      }
      for (const m of exec.rejected) rejected.push(m);
      for (const t of exec.researchTasks) researchTasks.push(t);
      if (exec.hasAccepted) {
        if (stage === "itinerary") {
          researchTasks.push(...await enrichItineraryPois({
            localProductId: state.localProductId,
            destination: skeleton.destination,
            runtime,
            persistedTaskKeys,
            resolvePoiName: planner.resolvePoiName?.bind(planner),
          }));
          const acceptedAfterPoi = await runtime.loadAcceptedModules(state.localProductId);
          if (!acceptedAfterPoi.includes("itinerary")) {
            const reason = "itinerary POI 映射未完整：仍有景点缺 poiName 或 poiId";
            accepted = accepted.filter((m) => m.module !== "itinerary");
            rejected.push({ module: "itinerary", status: "rejected", reason });
            lastError = { stage, attempt, code: "missing_module", message: reason };
            logAttemptError("行程 POI 映射未完整，准备重试", { stage, attempt, localProductId: state.localProductId });
            continue;
          }
        }
        if (stage === "commercial") {
          // commercial 阶段：套餐名由本地生成，pricing / inventory / release 由 AI 生成；terms 由 VBK 条款页处理。
          const required: readonly PlanningModule[] = STAGE_ALLOWED_MODULES.commercial as readonly PlanningModule[];
          const missing = required.filter((m) => !stageAcceptedModules!.has(m));
          if (missing.length === 0) {
            return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
          }
          // 还有缺失模块：标记本次缺哪些，进入下一轮 retry；已被接受的模块不再重发。
          lastError = { stage, attempt, code: "missing_module", message: `commercial 阶段尚缺模块：${missing.join("、")}` };
          logAttemptError("商业阶段部分模块缺失，准备重试补齐", { stage, attempt, localProductId: state.localProductId, missing: missing.join(",") });
          continue;
        }
        return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
      }
      const rejectionSummary = exec.rejected
        .map((item) => `${item.module}：${item.reason ?? "未说明原因"}`)
        .join("；");
      lastError = {
        stage,
        attempt,
        code: "missing_module",
        message: `本阶段没有接受任何模块（${allowed.join("、") || "无"}）${rejectionSummary ? `：${rejectionSummary}` : ""}`,
      };
      logAttemptError("阶段没有接受任何模块，准备重试", {
        stage,
        attempt,
        localProductId: state.localProductId,
        allowed: allowed.join(","),
        rejected: exec.rejected.map((item) => `${item.module}:${item.reason ?? "unknown"}`).join(" | "),
      });
    } catch (error) {
      lastError = toStageError(stage, attempt, error);
      logAttemptError("planner 抛错", { stage, attempt, localProductId: state.localProductId, code: lastError.code, message: lastError.message });
    }
  }

  const status: "needs_user" | "failed" = lastError && (lastError.code === "provider_authentication" || lastError.code === "provider_not_configured") ? "failed" : "needs_user";
  if (status === "needs_user") {
    logNoProgress("阶段达到 retry 上限未产出任何 accepted 模块", { stage, attempts, localProductId: state.localProductId, code: lastError?.code });
  } else {
    logStageEnd("阶段 fatal 终止", { stage, attempts, localProductId: state.localProductId, code: lastError?.code });
  }
  return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status });
}

/** 统一时间戳（ISO8601 字符串）；用于 persistence 与日志。 */
function now() { return new Date().toISOString(); }
