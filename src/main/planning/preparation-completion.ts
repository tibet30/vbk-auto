import type { AgentSnapshot, ProductDetail, ProductReadiness } from "../../shared/contracts.js";
import type { PlanningNodeId } from "../../shared/contracts-planning.js";
import {
  PREPARATION_PROMPT_VERSION,
  type PreparationAction,
  type PreparationEvaluation,
  type PreparationMajorStage,
} from "../../shared/contracts-preparation.js";
import { computeReadiness, type ComputeReadinessInput } from "../readiness.js";
import { extractLockedConstraints } from "../agent/prompt-helpers.js";
import { classifyItineraryInputMode } from "./itinerary-input-contract.js";
import {
  classifyReadinessIssue,
  extraPreparationGaps,
  POST_APPROVAL_DETERMINISTIC,
  type PreparationGap,
} from "./preparation-checks.js";

const STAGE_ORDER: readonly PreparationMajorStage[] = ["foundation", "itinerary", "completion"];
const NODE_ORDER: readonly PlanningNodeId[] = [
  "skeleton", "spotCandidates", "poiResolution", "itineraryDraft", "hotelResolution",
  "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation",
];

type ReadinessOptions = Pick<ComputeReadinessInput, "ignoreInterruptedAutomationFailure" | "ignoreCurrentAutomationFailure">;

export function evaluatePreparationCompletion(
  product: ProductDetail,
  snapshot?: AgentSnapshot,
  readinessOptions?: ReadinessOptions,
): PreparationEvaluation {
  const gaps = collectGaps(product, readinessOptions);
  const currentStage = firstStage(gaps) ?? "completion";
  const currentNode = firstNode(gaps) ?? "finalValidation";
  const ready = gaps.length === 0;
  const hasApproval = hasActiveApproval(snapshot);
  const actions = actionsFor(currentStage, gaps, ready, hasApproval);
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
    blockingReasons: gaps.map((gap) => `${gap.label}：${gap.detail}`),
    allowedActions: actions.allowed,
    prohibitedActions: actions.prohibited,
    completionCriteria: [
      "foundation：锁定目的地、天数和已有基础字段，不得覆盖 meetingCity",
      "itinerary：无用户行程则完整规划；有部分约束则只补空缺；完整输入只做规范化和 POI 核验",
      "completion：封面、副标题/推荐、套餐名称、定价、库存班期、适用酒店候选、适用用车、启用大交通时的端点核验",
      "request_approval 仅在 ready=true 时允许一次；条款属于批准后确定性写入",
    ],
    lockedConstraints,
    itineraryInputMode: classifyItineraryInputMode(lockedConstraints, Number(lockedConstraints.days) || 0, product.planning?.userIntent),
    postApprovalDeterministic: [...POST_APPROVAL_DETERMINISTIC],
  };
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
  for (const issue of readiness.issues) {
    push({ label: issue.label, detail: issue.detail, ...classifyReadinessIssue(issue.label, issue.detail) });
  }
  for (const gap of extraPreparationGaps(product.product)) push(gap);
  return gaps;
}

function firstStage(gaps: PreparationGap[]): PreparationMajorStage | undefined {
  return STAGE_ORDER.find((stage) => gaps.some((gap) => gap.stage === stage));
}

function firstNode(gaps: PreparationGap[]): PlanningNodeId | undefined {
  const stage = firstStage(gaps);
  const stageGaps = stage ? gaps.filter((gap) => gap.stage === stage) : gaps;
  return NODE_ORDER.find((node) => stageGaps.some((gap) => gap.node === node)) ?? stageGaps[0]?.node;
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

function actionsFor(
  stage: PreparationMajorStage,
  gaps: PreparationGap[],
  ready: boolean,
  hasApproval: boolean,
): { allowed: PreparationAction[]; prohibited: PreparationAction[] } {
  const read: PreparationAction[] = ["read_product", "ask_user"];
  if (ready) {
    return hasApproval
      ? { allowed: read, prohibited: ["request_approval", "generate_product_module"] }
      : { allowed: [...read, "request_approval"], prohibited: ["generate_product_module"] };
  }
  if (stage === "foundation") {
    return { allowed: [...read, "generate_product_module", "patch_product"], prohibited: ["request_approval"] };
  }
  if (stage === "itinerary") {
    return {
      allowed: [...read, "generate_product_module", "patch_product", "query_poi", "select_itinerary_poi", "resolve_itinerary_pois"],
      prohibited: ["request_approval"],
    };
  }
  const allowed: PreparationAction[] = [...read, "generate_product_module", "ensure_presentation_recommendations", "patch_product"];
  const labels = gaps.map((gap) => gap.label).join(" ");
  if (/封面/.test(labels)) allowed.push("resolve_cover");
  if (/酒店候选/.test(labels)) allowed.push("resolve_itinerary_hotels");
  if (/用车/.test(labels)) allowed.push("resolve_vehicle_resource");
  if (/大交通/.test(labels)) allowed.push("recheck_traffic_line_availability");
  return { allowed: [...new Set(allowed)], prohibited: ["request_approval"] };
}
