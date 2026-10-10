/**
 * 三个「不需要 AI」的子阶段（deterministic）：
 *   - runSkeletonStage：直接拼骨架（hotelTier / pickupCity / transport），无 AI；
 *   - runValidationStage：跑 validateCompleteness + deepValidateModules，必要时
 *     buildRewoundState 回滚；
 *   - runResearchStage：补 presentation cover + pending research tasks，commit。
 *
 * 三个 stage 都共用 `makeStageResult` 收口；这里只放"具体怎么跑这一阶段"。
 */

import { AI_WRITABLE_PATHS } from "../schemas.js";
import { upsertStageInState } from "../stage-runner.js";
import {
  validateCompleteness,
  deepValidateModules,
} from "../validation.js";
import { composeStageAssistantReply } from "../replies.js";
import { pendingResearchTasks } from "../research-tasks.js";
import { buildRewoundState } from "../validation-rewind.js";
import { resolveTravelScope } from "../runtime.js";
import { ensurePresentationCover } from "../cover-default.js";
import { FIVE_DIAMOND_HOTEL_TIER } from "../../../shared/hotel-tiers.js";
import {
  defaultDailyTransport,
  isDailyTransport,
} from "../../../shared/product-form.js";
import type {
  ModuleOutcome,
  PlanningGenerationState,
  PlanningSkeleton,
  PlanningStageError,
  ResearchTaskProposal,
} from "../../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "../types.js";
import { makeStageResult, now } from "./result.js";
import type { SingleStageResult } from "./types.js";

export async function runSkeletonStage(args: {
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
    const current = typeof runtime.loadCurrentProduct === "function"
      ? await runtime.loadCurrentProduct(state.localProductId)
      : undefined;
    const existingTier = (current?.operations as { hotelTier?: string } | undefined)?.hotelTier;
    const existingTransport = (current?.operations as { transport?: unknown } | undefined)?.transport;
    const splitGroup = (current?.sales as { splitGroup?: unknown } | undefined)?.splitGroup;
    const result = await runtime.writeModule(state.localProductId, "skeleton", AI_WRITABLE_PATHS.skeleton, {
      // 用户已明确几钻时保留；未指定才回落到当地 5 钻模板。
      hotelTier: existingTier || FIVE_DIAMOND_HOTEL_TIER,
      pickupCity: travelScope.primaryCity,
      // 有效的人工选择优先；仅在新产品或历史草稿缺值时按团态补默认。
      transport: isDailyTransport(existingTransport)
        ? existingTransport
        : defaultDailyTransport(skeleton.productForm, splitGroup),
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

export async function runValidationStage(args: {
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

export async function runResearchStage(args: {
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