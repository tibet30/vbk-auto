import type { AgentSnapshot, ProductDetail, ProductReadiness } from "../../shared/contracts.js";
import {
  PREPARATION_PROMPT_VERSION,
  type PreparationEvaluation,
} from "../../shared/contracts-preparation.js";
import { computeReadiness, type ComputeReadinessInput } from "../readiness.js";
import { extractLockedConstraints } from "../agent/prompt-helpers.js";
import { classifyItineraryInputMode, itineraryInputContractError } from "./itinerary-input-contract.js";
import { readActiveCoverFallback } from "../../shared/cover-fallback.js";
import { itineraryStructureError } from "./itinerary-structure.js";
import {
  classifyReadinessIssue,
  extraPreparationGaps,
  POST_APPROVAL_DETERMINISTIC,
  type PreparationGap,
} from "./preparation-checks.js";

import { preparationActions, preparationPosition } from "./preparation/policy.js";

type ReadinessOptions = Pick<ComputeReadinessInput, "ignoreInterruptedAutomationFailure" | "ignoreCurrentAutomationFailure">;

export function evaluatePreparationCompletion(
  product: ProductDetail,
  snapshot?: AgentSnapshot,
  readinessOptions?: ReadinessOptions,
): PreparationEvaluation {
  const gaps = collectGaps(product, readinessOptions);
  const { stage: currentStage, node: currentNode } = preparationPosition(gaps);
  const ready = gaps.length === 0;
  const hasApproval = hasActiveApproval(snapshot);
  const fallback = readActiveCoverFallback(product.product);
  const actions = preparationActions({
    stage: currentStage, gaps, ready, hasApproval,
    coverSearchExhausted: fallback?.reason === "no_qualified_candidate",
  });
  const userMessages = (product.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => ({ role: "user" as const, content: message.content }));
  const lockedConstraints = extractLockedConstraints(product, userMessages);
  return {
    promptVersion: PREPARATION_PROMPT_VERSION,
    ready,
    currentStage,
    currentNode,
    missing: gaps.map((gap) => gap.label),
    gaps,
    blockingReasons: gaps.map((gap) => `${gap.label}：${gap.detail}`),
    allowedActions: actions.allowed,
    prohibitedActions: actions.prohibited,
    completionCriteria: [
      "foundation：锁定目的地、天数和已有基础字段，不得覆盖 meetingCity",
      "itinerary：无用户行程则完整规划；有部分约束则只补空缺；完整输入只做规范化和 POI 核验",
      "completion：封面、副标题/推荐、套餐名称、定价、库存班期、适用平台酒店规则、适用用车、启用大交通时的端点核验",
      "request_approval 仅在 ready=true 时允许一次；条款属于批准后确定性写入",
    ],
    lockedConstraints,
    itineraryInputMode: classifyItineraryInputMode(lockedConstraints, Number(lockedConstraints.days) || 0, product.planning?.userIntent),
    postApprovalDeterministic: [...POST_APPROVAL_DETERMINISTIC],
  };
}

/** A placeholder can proceed through approval only when every other draft field is ready. */
export function isCoverHandoffReady(product: ProductDetail): boolean {
  if (!readActiveCoverFallback(product.product)) return false;
  return collectGaps(product).length === 0;
}

const READINESS_MAX_BLOCKERS = 12;

export function toVisibleReadiness(evaluation: PreparationEvaluation): ProductReadiness {
  const issues = evaluation.missing.map((label, index) => ({
    label,
    detail: stripLabelPrefix(evaluation.blockingReasons[index] ?? label, label),
  }));
  const blockerCount = issues.length;
  const completion = Math.round(
    (Math.max(0, READINESS_MAX_BLOCKERS - Math.min(READINESS_MAX_BLOCKERS, blockerCount)) / READINESS_MAX_BLOCKERS) * 100,
  );
  return { ready: evaluation.ready, completion: evaluation.ready ? 100 : completion, issues };
}

export function evaluateVisibleReadiness(
  product: ProductDetail,
  snapshot?: AgentSnapshot,
  readinessOptions?: ReadinessOptions,
): ProductReadiness {
  return toVisibleReadiness(evaluatePreparationCompletion(product, snapshot, readinessOptions));
}

export function preparationApprovalBlockReason(product: ProductDetail, snapshot?: AgentSnapshot): string | undefined {
  const evaluation = evaluatePreparationCompletion(product, snapshot);
  if (evaluation.ready) return undefined;
  const missing = evaluation.missing.slice(0, 5).join("、") || evaluation.blockingReasons[0] || "未完成本地准备";
  return `本地方案尚未准备完成，不能进入 VBK 录入：当前阶段 ${evaluation.currentStage}/${evaluation.currentNode}，缺失 ${missing}`;
}

function stripLabelPrefix(detail: string, label: string): string {
  const prefix = `${label}：`;
  return detail.startsWith(prefix) ? detail.slice(prefix.length) : detail;
}

function collectGaps(product: ProductDetail, readinessOptions?: ReadinessOptions): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const seen = new Set<string>();
  const push = (gap: PreparationGap) => {
    if (seen.has(gap.label)) return;
    seen.add(gap.label);
    gaps.push(gap);
  };
  const readiness = computeReadiness({
    product: product.product,
    researchTasks: product.researchTasks,
    automation: product.automation,
    ignoreCurrentAutomationFailure: readinessOptions?.ignoreCurrentAutomationFailure ?? true,
    ignoreInterruptedAutomationFailure: readinessOptions?.ignoreInterruptedAutomationFailure,
  });
  const structureError = itineraryStructureError(product.product);
  const itineraryContractError = itineraryInputContractError(product, product.product.itinerary);
  if (itineraryContractError) {
    push({ code: "itinerary", label: "每日行程", detail: itineraryContractError, stage: "itinerary", node: "itineraryDraft" });
  }
  for (const issue of readiness.issues) {
    const classified = issue.label === "平台酒店规则" || /^itinerary\.\d+\.hotelCandidates(?:\.|$)/.test(issue.label)
      ? { code: "hotel" as const, stage: "completion" as const, node: "hotelResolution" as const }
      : classifyReadinessIssue(issue.label, issue.detail);
    const itineraryIssue = classified.stage === "itinerary" && (classified.node === "itineraryDraft" || classified.node === "poiResolution");
    push({
      label: issue.label,
      detail: issue.detail,
      ...(itineraryIssue
        ? { code: structureError ? "itinerary" as const : "poi" as const, stage: "itinerary" as const, node: structureError ? "itineraryDraft" as const : "poiResolution" as const }
        : classified),
    });
  }
  for (const gap of extraPreparationGaps(product.product, product)) push(gap);
  return gaps;
}

function hasActiveApproval(snapshot?: AgentSnapshot): boolean {
  if (!snapshot) return false;
  if (snapshot.pendingApproval?.status === "pending") return true;
  const approved = snapshot.events
    .filter((event) => event.type === "approval")
    .map((event) => event.data?.approval as { status?: string; intentVersion?: string } | undefined)
    .reverse()
    .find((item) => item?.status === "approved");
  return Boolean(approved && approved.intentVersion === snapshot.run?.intentVersion);
}
