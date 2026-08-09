/**
 * 规划编排器（orchestrator）。
 *
 *  - 单调流式：skeleton → itinerary → presentation → commercial → research → validation；
 *  - skeleton / research / validation 是**本地阶段**，不调用 AI；
 *  - 其它 AI 阶段独立 retry，retry 次数受 stageRetryLimit 控制（默认 2）；
 *  - 已成功阶段不会被重跑（除非显式 forceRerun）；
 *  - 进度通过 GenerationStateStore 持久化；进程崩溃后从 currentStage 续跑；
 *  - 拒绝把 supplierProductCode / 资源 ID 等运营数据写入产品；
 *  - release 模块默认 draft-only（submitReview=false / publishAfterApproval=false）；
 *  - assistant 回复基于「实际接受 / 缺失模块」重建，不接受模型声明；
 *  - validation 阶段从持久化产品 + 持久化 stage 状态反推完整性。
 */

import {
  PLANNING_STAGES,
  PLANNING_STAGE_RETRY_LIMIT,
  type PlanningGenerationState,
  type ModuleOutcome,
  type PlanningModule,
  type PlanningStage,
  type Planner,
  type ResearchTaskProposal,
  type PlanningSkeleton,
} from "../../shared/contracts-planning.js";
import { validateCompleteness } from "./validation.js";
import { composeAssistantReply } from "./replies.js";
import { runSingleStage, type SingleStageResult } from "./single-stage-runner.js";
import { enrichItineraryPois } from "./poi-enrichment.js";
import { revalidateCompletedState } from "./validation-rewind.js";
import { logRunEnd, logRunStart, logStageEnd, logStageStart } from "./log.js";
import type {
  OrchestratorRunResult,
  OrchestratorOptions,
  GenerationStateStore,
  OrchestratorRuntime,
} from "./types.js";

export type {
  OrchestratorRunResult,
  OrchestratorOptions,
  GenerationStateStore,
  OrchestratorRuntime,
};

export interface RunPlanArgs {
  projectId: string;
  skeleton: PlanningSkeleton;
  store: GenerationStateStore;
  runtime: OrchestratorRuntime;
  planner: Planner;
  providerLabel?: string;
  options?: OrchestratorOptions;
}

/**
 * 一次性跑完（或续跑）整个 plan。
 *
 * 续跑语义：
 *  - 已 `completedStages` 中的阶段**不重跑**（无论持久化的 accepted/rejected 列表）。
 *  - 启动点 = `state.currentStage`；当 currentStage 仍处于已完成阶段时，
 *    直接跳到下一个未完成阶段。
 *  - 已落地的 accepted 模块通过 `runtime.loadAcceptedModules(projectId)` 重新读出；
 *    因此即使进程重启后内存 accumulator 丢失，也不会影响 completeness 判断。
 */
export async function runPlan(args: RunPlanArgs): Promise<OrchestratorRunResult> {
  const opts = args.options ?? {};
  const stageRetryLimit = opts.stageRetryLimit ?? PLANNING_STAGE_RETRY_LIMIT;
  const enforceValidation = opts.enforceValidation !== false;

  let state = (await args.store.load(args.projectId)) ?? createInitialState(args.projectId, opts.providerLabel);

  logRunStart("runPlan 进入", {
    projectId: args.projectId,
    providerLabel: args.providerLabel,
    currentStage: state.currentStage,
    completedStages: state.completedStages.join(","),
    status: state.status,
  });

  // 完成状态必须重新校验：state.completedStages / status 不可信；
  // 任何已完成阶段实际产品如果被运营 / 手工改坏、或 shallow 检测把非法
  // 行程 / presentation / commercial 当成 accepted 永久跳过，都会被 deep
  // validation 抓出来并 rewind 到 earliest invalid stage，状态置 needs_user。
  if (state.status === "completed") {
    state = await revalidateCompletedState({ state, skeleton: args.skeleton, runtime: args.runtime });
    // revalidate 发现已完成产品被改坏时，rewindForInvalid 已将 currentStage
    // 定位到最早失效阶段；本次 resume 应立即重跑该阶段，而不是把 needs_user
    // 当成终止态返回。只有无 invalid 时才保持 completed 并走末尾确认路径。
    if (state.status === "needs_user") state.status = "pending";
    await args.store.save(state);
  }

  // 跳过「当前阶段 ≤ 已完成阶段」的所有阶段：从 currentStage 起跑。
  // 即使 currentStage 落后于 completedStages（例如 needs_user 中断后
  // state.currentStage 没被推进），也会被此 while 推进到下一个未完成阶段。
  let startIndex = PLANNING_STAGES.indexOf(state.currentStage);
  if (startIndex < 0) startIndex = 0;
  let skippedFromCurrent = 0;
  while (startIndex < PLANNING_STAGES.length && state.completedStages.includes(PLANNING_STAGES[startIndex])) {
    skippedFromCurrent += 1;
    startIndex += 1;
  }
  if (skippedFromCurrent > 0) {
    logRunStart(`续跑跳过 ${skippedFromCurrent} 个已完成阶段`, {
      projectId: args.projectId,
      providerLabel: args.providerLabel,
      skippedStages: PLANNING_STAGES.slice(0, skippedFromCurrent).join(","),
      resumeStage: PLANNING_STAGES[startIndex] ?? "<none>",
    });
  }
  if (startIndex >= PLANNING_STAGES.length) {
    // 全部阶段都被 completedStages 走过一次；仍然要 deep-validate，避免
    // shallow detectAcceptedModules 把非法行程 / presentation / commercial
    // 当成 accepted 永久跳过。再发现 invalid 就 rewind + return needs_user。
    state = await revalidateCompletedState({ state, skeleton: args.skeleton, runtime: args.runtime });
    await args.store.save(state);
    if (state.status === "needs_user") {
      logRunEnd("续跑走到末尾但 deep validation 发现 invalid，回退 needs_user", { projectId: args.projectId, providerLabel: args.providerLabel, status: state.status });
      return finalizeRun(state, await args.runtime.loadAcceptedModules(args.projectId));
    }
    // 已完成方案也可能是旧版本在 POI 查询超时前就走到了 validation。
    // 此处只对空 POI 做补全：不调用 planner、不改变 completedStages 或阶段状态。
    // enrichItineraryPois 仅在实际匹配到结果时写 itinerary；无缺失或无匹配都不会
    // 产生无意义的模块重写。放在稳定 completed 返回前，确保用户点「继续规划」
    // 能修复历史草稿，而不会被末尾短路跳过。
    const existingTasks = await args.runtime.loadExistingResearchTasks(args.projectId);
    const persistedTaskKeys = new Set(existingTasks.map((task) => `${task.type}::${task.label}`));
    const poiResearchTasks = await enrichItineraryPois({
      projectId: args.projectId,
      destination: args.skeleton.destination,
      runtime: args.runtime,
      persistedTaskKeys,
      resolvePoiName: args.planner.resolvePoiName?.bind(args.planner),
    });
    state.status = "completed";
    await args.store.save(state);
    logRunEnd("续跑走到末尾确认 completed", { projectId: args.projectId, providerLabel: args.providerLabel, status: state.status });
    return finalizeRun(state, await args.runtime.loadAcceptedModules(args.projectId), poiResearchTasks);
  }

  state.status = "running";
  state.currentStage = PLANNING_STAGES[startIndex];
  logStageStart("续跑起点", { projectId: args.projectId, stage: state.currentStage, completedStages: state.completedStages.join(","), providerLabel: args.providerLabel });
  await args.store.save(state);

  const existingTasks = await args.runtime.loadExistingResearchTasks(args.projectId);
  const history = await args.runtime.loadHistory(args.projectId);
  const accumulatedResearchTasks: ResearchTaskProposal[] = [];

  // 历史版本把 itinerary 标为已完成后，POI 查询可能因超时而未写回。
  // resume 不能重跑 AI 行程，也不能等到后续阶段全部结束才补：在进入
  // presentation 前只查询缺失 POI，并沿用既有的 VBK 核查任务去重语义。
  if (state.completedStages.includes("itinerary")) {
    const persistedTaskKeys = new Set(existingTasks.map((task) => `${task.type}::${task.label}`));
    accumulatedResearchTasks.push(...await enrichItineraryPois({
      projectId: args.projectId,
      destination: args.skeleton.destination,
      runtime: args.runtime,
      persistedTaskKeys,
      resolvePoiName: args.planner.resolvePoiName?.bind(args.planner),
    }));
  }

  for (let i = startIndex; i < PLANNING_STAGES.length; i += 1) {
    const stage = PLANNING_STAGES[i];
    if (stage === "presentation" && !state.completedStages.includes("commercial")) {
      const parallelStages = (["presentation", "commercial"] as const).filter((s) => !state.completedStages.includes(s));
      let writeTail = Promise.resolve();
      const parallelRuntime = Object.create(args.runtime) as OrchestratorRuntime;
      Object.assign(parallelRuntime, {
        writeModule: async (...writeArgs: Parameters<OrchestratorRuntime["writeModule"]>) => {
          let resolveResult!: (value: Awaited<ReturnType<OrchestratorRuntime["writeModule"]>>) => void;
          const resultPromise = new Promise<Awaited<ReturnType<OrchestratorRuntime["writeModule"]>>>(resolve => { resolveResult = resolve; });
          writeTail = writeTail.then(async () => resolveResult(await args.runtime.writeModule(...writeArgs)));
          return resultPromise;
        },
      });
      const parallelResults = await Promise.all(parallelStages.map((s) => runSingleStage({
        stage: s, state, skeleton: args.skeleton, planner: args.planner, runtime: parallelRuntime,
        retryLimit: stageRetryLimit, history, existingTasks, providerLabel: args.providerLabel,
      })));
      let failed: { stage: string; result: SingleStageResult } | undefined;
      for (let n = 0; n < parallelResults.length; n += 1) {
        const result = parallelResults[n];
        const parallelStage = parallelStages[n];
        state = { ...state, stages: [
          ...state.stages.filter(entry => entry.stage !== parallelStage),
          ...result.state.stages.filter(entry => entry.stage === parallelStage),
        ] };
        for (const t of result.researchTasks) accumulatedResearchTasks.push(t);
        if (result.status === "needs_user" || result.status === "failed") failed = { stage: parallelStage, result };
        else state.completedStages = Array.from(new Set([...state.completedStages, parallelStage]));
        state.lastAssistantReply = result.assistantReply;
        state.lastModuleSummary = [...result.accepted, ...result.rejected];
        state.lastMissingSummary = result.rejected.filter((m) => m.status === "missing").map((m) => m.module);
      }
      state.currentStage = failed?.stage as typeof state.currentStage ?? "research";
      state.status = failed ? failed.result.status : "running";
      await args.store.save(state);
      if (failed) return finalizeRun(state, await args.runtime.loadAcceptedModules(args.projectId), accumulatedResearchTasks);
      i += 1;
      continue;
    }
    const result = await runSingleStage({
      stage,
      state,
      skeleton: args.skeleton,
      planner: args.planner,
      runtime: args.runtime,
      retryLimit: stageRetryLimit,
      history,
      existingTasks,
      providerLabel: args.providerLabel,
    });
    state = result.state;
    for (const t of result.researchTasks) accumulatedResearchTasks.push(t);
    if (result.status === "needs_user" || result.status === "failed") {
      // 失败 / 需要人工介入是终态，原样持久化，保留当前失败阶段供恢复入口使用。
      await args.store.save(state);
      logRunEnd("runPlan 提前结束于 mid-stage", { projectId: args.projectId, providerLabel: args.providerLabel, stage, status: result.status, acceptedCount: result.accepted.length, rejectedCount: result.rejected.length });
      return finalizeRun(state, await args.runtime.loadAcceptedModules(args.projectId), accumulatedResearchTasks);
    }
    // runSingleStage 成功时会返回该阶段自己的 completed 状态。不要先把这个
    // 中间结果写入 store：renderer 轮询到 status=completed 会停止，从而错过
    // 后续阶段。成功快照必须原子地同时推进 completedStages、currentStage，
    // 并保持整个计划仍为 running；只有循环结束后才写真正的 completed。
    state.completedStages = Array.from(new Set([...state.completedStages, stage]));
    state.currentStage = PLANNING_STAGES[Math.min(i + 1, PLANNING_STAGES.length - 1)];
    state.status = "running";
    state.lastAssistantReply = result.assistantReply;
    state.lastModuleSummary = [...result.accepted, ...result.rejected];
    state.lastMissingSummary = result.rejected.filter((m) => m.status === "missing").map((m) => m.module);
    await args.store.save(state);
    logStageEnd("阶段已接受，写入 completedStages", { projectId: args.projectId, stage, acceptedCount: result.accepted.length, rejectedCount: result.rejected.length });
  }

  // validation 已在循环内完成；从持久化产品反推最终 completeness。
  const accepted = await args.runtime.loadAcceptedModules(args.projectId);
  const validation = validateCompleteness({ acceptedModules: accepted });
  if (enforceValidation && !validation.complete) {
    state.status = "needs_user";
  } else {
    state.status = "completed";
  }
  await args.store.save(state);
  logRunEnd("runPlan 全流程完成", { projectId: args.projectId, providerLabel: args.providerLabel, status: state.status, complete: validation.complete });
  return finalizeRun(state, accepted, accumulatedResearchTasks);
}

/**
 * 把最终 state 转为对外 OrchestratorRunResult：
 *   - 用 validation 决定 accepted / rejected；
 *   - composeAssistantReply 生成中文 assistant 回复；
 *   - status 随 state.status 映射为 completed / failed / needs_user。
 */
async function finalizeRun(state: PlanningGenerationState, acceptedModules: readonly PlanningModule[], researchTasks: ResearchTaskProposal[] = []): Promise<OrchestratorRunResult> {
  const validation = validateCompleteness({ acceptedModules });
  const nowIso = new Date().toISOString();
  const accepted: OrchestratorRunResult["accepted"] = validation.accepted.map((m) => ({
    module: m.module,
    status: "accepted",
    writePath: m.writePath,
    acceptedFields: m.acceptedFields,
    missingFields: m.missingFields,
    updatedAt: nowIso,
  }));
  const rejected: OrchestratorRunResult["rejected"] = validation.missing.map((m) => ({
    module: m.module,
    status: m.status === "missing" ? "missing" : "rejected",
    reason: m.reason,
    writePath: m.writePath,
  }));
  return {
    state,
    accepted,
    rejected,
    researchTasks,
    status: state.status === "completed" ? "completed" : state.status === "failed" ? "failed" : "needs_user",
    assistantReply: composeAssistantReply(state, validation.accepted, validation.missing),
  };
}

/**
 * 生成一份全新 PlanningGenerationState：起点是 skeleton，未完成任何阶段，状态 pending。
 * resumeAt 为当前 ISO 时间，providerLabel 透传供 UI 顶部展示。
 */
function createInitialState(projectId: string, providerLabel?: string): PlanningGenerationState {
  return {
    projectId,
    currentStage: "skeleton",
    completedStages: [],
    stages: [],
    status: "pending",
    resumeAt: new Date().toISOString(),
    providerLabel,
  };
}

/** 统一时间戳（ISO8601），用于 state.resumeAt 等字段。 */
function now() { return new Date().toISOString(); }
