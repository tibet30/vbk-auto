/**
 * 单阶段执行器：被 plan-orchestrator 主循环调用一次，负责把某个阶段从
 * planner / runtime 输入推进到下一阶段。
 *
 *  抽出到独立文件是为了保持 plan-orchestrator.ts 在 size budget 内
 * （≤350 行）；这块代码自包含、零外部依赖（除开 schemas / stage-runner / validation）。
 */

import { AI_WRITABLE_PATHS, STAGE_ALLOWED_MODULES } from "./schemas.js";
import {
  executeStageOutput,
  upsertStageInState,
  toStageError,
} from "./stage-runner.js";
import {
  validateCompleteness,
  deepValidateModules,
} from "./validation.js";
import { composeStageAssistantReply } from "./replies.js";
import { pendingResearchTasks } from "./research-tasks.js";
import { buildRewoundState } from "./validation-rewind.js";
import { logAttemptError, logNoProgress, logStageEnd, logStageStart } from "./log.js";
import type {
  ModuleOutcome,
  Planner,
  PlannerContext,
  PlanningGenerationState,
  PlanningModule,
  PlanningStage,
  PlanningStageError,
  ResearchTaskProposal,
  PlanningSkeleton,
} from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";

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

/**
 * 跑一个阶段并返回结果。骨架 / research / validation 三阶段由本地 deterministic
 * 完成；其余 AI 阶段受 retryLimit 控制。
 */
export async function runSingleStage(args: RunSingleStageArgs): Promise<SingleStageResult> {
  const { stage, state, skeleton, planner, runtime, retryLimit, history, existingTasks } = args;
  const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  let attempts = state.stages.find((s) => s.stage === stage)?.attempts ?? 0;
  let lastError: PlanningStageError | undefined;
  logStageStart("进入阶段", { stage, projectId: state.projectId, attempts });

  // skeleton 阶段由本地完成；不调用 AI。
  if (stage === "skeleton") {
    return await runSkeletonStage({ state, skeleton, runtime, attempts, lastError });
  }

  // validation 阶段：从持久化产品反推完整性，不调用 AI。
  if (stage === "validation") {
    return await runValidationStage({ state, skeleton, runtime, attempts, lastError });
  }

  // research 阶段：本地 deterministic 任务生成，不调用 AI。
  if (stage === "research") {
    return await runResearchStage({ state, skeleton, runtime, existingTasks, attempts, lastError });
  }

  // 其他 AI 阶段：调 planner 重试 retryLimit 次，成功的 stage 立即收尾。
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
  // 已有 valid skeleton（hotelTier / pickupCity / transport 都在）→ 跳过写入，避免覆盖人工 / VBK 修正。
  const alreadyAccepted = await runtime.loadAcceptedModules(state.projectId);
  if (alreadyAccepted.includes("skeleton")) {
    accepted.push({ module: "skeleton", status: "accepted", writePath: AI_WRITABLE_PATHS.skeleton, acceptedFields: ["hotelTier", "pickupCity", "transport"] });
    return makeStageResult({ state, stage: "skeleton", accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
  }
  const result = await runtime.writeModule(state.projectId, "skeleton", AI_WRITABLE_PATHS.skeleton, {
    hotelTier: skeleton.productForm === "privateTour" ? "当地5钻酒店/-38" : "当地3钻酒店/-3",
    pickupCity: skeleton.destination,
    transport: "charter",
    reusePickupForDropoff: true,
    mealsIncluded: false,
  });
  if (!result.ok) {
    rejected.push({ module: "skeleton", status: "rejected", reason: result.reason || "骨架写入失败" });
    return makeStageResult({ state, stage: "skeleton", accepted, rejected, researchTasks, attempts, lastError, status: "failed" });
  }
  accepted.push({ module: "skeleton", status: "accepted", writePath: AI_WRITABLE_PATHS.skeleton, acceptedFields: ["hotelTier", "pickupCity", "transport"] });
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
  const acceptedFromProduct = await runtime.loadAcceptedModules(state.projectId);
  const validation = validateCompleteness({ acceptedModules: acceptedFromProduct });
  for (const m of validation.accepted) accepted.push(m);
  for (const m of validation.missing) rejected.push(m);
  // Deep validation：模块存在但内容不合法时，标记为 rejected 并报告原因。
  const product = await runtime.loadCurrentProduct(state.projectId);
  const deep = deepValidateModules({
    skeleton,
    product,
    acceptedModules: acceptedFromProduct,
  });
  for (const inv of deep.invalid) rejected.push(inv);
  let stateAfter = { ...state, stages: upsertStageInState(state, "validation", { accepted, rejected, attempts, lastError, updatedAt: now() }) };
  // invalid 模块需要 rewind：shallow detectAcceptedModules 把非法 itinerary/presentation/commercial
  // 当成 accepted 永久跳过会被 deep validation 抓出来。这里主动把
  // completedStages 截断到 earliest invalid stage，让下一次 resume 从
  // 那个阶段重跑；更早的合法阶段保持不变。
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
  // AI 不能写「已确认 / 已解决」措辞，也不能决定哪个核查项已落地；
  // 这里只生成「待运营 / VBK 核查」的提案，runtime.addResearchTask 负责去重落库。
  const acceptedFromProduct = await runtime.loadAcceptedModules(state.projectId);
  const product = await runtime.loadCurrentProduct(state.projectId);
  const pending = pendingResearchTasks({
    skeleton,
    product,
    acceptedModules: acceptedFromProduct,
    existing: existingTasks,
  });
  for (const entry of pending) {
    await runtime.addResearchTask(state.projectId, entry.proposal);
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

function makeStageResult(args: MakeStageResultArgs): SingleStageResult {
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
    stages: upsertStageInState(args.state, args.stage, { accepted: args.accepted, rejected: args.rejected, attempts: args.attempts, lastError: args.lastError, updatedAt: now() }),
  };
  return {
    state: stateAfter,
    accepted: args.accepted,
    rejected: args.rejected,
    researchTasks: args.researchTasks,
    status: args.status,
    assistantReply: composeStageAssistantReply(args.stage, args.accepted, args.rejected),
  };
}

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

  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    attempts = attempt;
    // commercial 阶段：维护「已 accepted 模块集合」，重试只补缺失模块；已接受的模块
    // 不再要求 AI 重发，避免覆盖已落地的合法数据。
    const stageAcceptedModules = stage === "commercial"
      ? new Set<PlanningModule>()
      : undefined;
    if (stage === "commercial") {
      const already = await runtime.loadAcceptedModules(state.projectId);
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
      const alreadyAccepted = await runtime.loadAcceptedModules(state.projectId);
      const sole = stage === "itinerary" ? "itinerary" : "presentation";
      if (alreadyAccepted.includes(sole)) {
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
      currentProduct: await runtime.loadCurrentProduct(state.projectId),
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
      const exec = await executeStageOutput({ stage, output, runtime, projectId: state.projectId });
      for (const m of exec.accepted) {
        accepted.push(m);
        stageAcceptedModules?.add(m.module);
      }
      for (const m of exec.rejected) rejected.push(m);
      for (const t of exec.researchTasks) researchTasks.push(t);
      if (exec.hasAccepted) {
        if (stage === "commercial") {
          // commercial 阶段：必须五个模块（packageName + pricing + inventory + terms + release）全部 accepted 才算完成。
          const required: readonly PlanningModule[] = STAGE_ALLOWED_MODULES.commercial as readonly PlanningModule[];
          const missing = required.filter((m) => !stageAcceptedModules!.has(m));
          if (missing.length === 0) {
            return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
          }
          // 还有缺失模块：标记本次缺哪些，进入下一轮 retry；已被接受的模块不再重发。
          lastError = { stage, attempt, code: "missing_module", message: `commercial 阶段尚缺模块：${missing.join("、")}` };
          logAttemptError("商业阶段部分模块缺失，准备重试补齐", { stage, attempt, projectId: state.projectId, missing: missing.join(",") });
          continue;
        }
        return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status: "completed" });
      }
      lastError = { stage, attempt, code: "missing_module", message: `本阶段没有接受任何模块（${allowed.join("、") || "无"}）` };
      logAttemptError("阶段没有接受任何模块，准备重试", { stage, attempt, projectId: state.projectId, allowed: allowed.join(",") });
    } catch (error) {
      lastError = toStageError(stage, attempt, error);
      logAttemptError("planner 抛错", { stage, attempt, projectId: state.projectId, code: lastError.code, message: lastError.message });
    }
  }

  const status: "needs_user" | "failed" = lastError && (lastError.code === "provider_authentication" || lastError.code === "provider_not_configured") ? "failed" : "needs_user";
  if (status === "needs_user") {
    logNoProgress("阶段达到 retry 上限未产出任何 accepted 模块", { stage, attempts, projectId: state.projectId, code: lastError?.code });
  } else {
    logStageEnd("阶段 fatal 终止", { stage, attempts, projectId: state.projectId, code: lastError?.code });
  }
  return makeStageResult({ state, stage, accepted, rejected, researchTasks, attempts, lastError, status });
}

function now() { return new Date().toISOString(); }