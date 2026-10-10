/**
 * 单阶段执行器的"AI 通用重试循环"（商业 / 行程 / 产品图文等）：
 *   - 维护 stageAcceptedModules（commercial 阶段专用）；
 *   - 单模块阶段（itinerary/presentation）若已 accepted，直接跳出；
 *   - planner.generateStage → executeStageOutput；失败重试 retryLimit 次；
 *   - 全部 retry 用完仍无 accepted → needs_user 或 failed（取决于错误码）。
 *
 * 这是单阶段执行器最重的一块；拆到这里，方便后续把商业 / 行程阶段分得更细。
 */

import { AI_WRITABLE_PATHS } from "../schemas.js";
import { STAGE_ALLOWED_MODULES } from "../stage-contract.js";
import { executeStageOutput, toStageError } from "../stage-runner.js";
import { logAttemptError, logNoProgress, logStageEnd } from "../log.js";
import { enrichItineraryPois } from "../poi-enrichment.js";
import {
  ensureCommercialFallbacks,
  ensurePackageName,
} from "../commercial-stage.js";
import { logInfo } from "../../../shared/log-timestamp.js";
import type {
  ModuleOutcome,
  Planner,
  PlannerContext,
  PlanningGenerationState,
  PlanningModule,
  PlanningSkeleton,
  PlanningStage,
  PlanningStageError,
  ResearchTaskProposal,
} from "../../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "../types.js";
import { makeStageResult, now } from "./result.js";
import type { SingleStageResult } from "./types.js";

export async function runAiStage(args: {
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
      const acceptedThisAttempt = [...exec.accepted];
      const rejectedThisAttempt = [...exec.rejected];
      if (stage === "commercial") {
        // 模型只要未给出有效商业字段，就用已落库的行程规模生成可审核的
        // 指导价/库存/草稿发布配置；不把未核实的供应商报价当作真实成本。
        const fallback = await ensureCommercialFallbacks({
          localProductId: state.localProductId,
          skeleton,
          runtime,
        });
        acceptedThisAttempt.push(...fallback.accepted);
        rejectedThisAttempt.push(...fallback.rejected);
      }
      for (const m of acceptedThisAttempt) {
        accepted.push(m);
        stageAcceptedModules?.add(m.module);
      }
      for (const m of rejectedThisAttempt) rejected.push(m);
      for (const t of exec.researchTasks) researchTasks.push(t);
      if (acceptedThisAttempt.length > 0) {
        if (stage === "itinerary") {
          researchTasks.push(...await enrichItineraryPois({
            localProductId: state.localProductId,
            destination: skeleton.destination,
            runtime,
            persistedTaskKeys,
            // 重跑行程规划也必须复核已绑定 POI；否则历史行程只会补空 ID，
            // 已暂停营业的景点会被错误保留。
            reviewCompletePois: true,
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