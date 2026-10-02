import type { AgentSnapshot, ProductDetail } from "../../shared/contracts.js";
import type { PreparationAction, PreparationEvaluation, PreparationMajorStage } from "../../shared/contracts-preparation.js";
import { evaluatePreparationCompletion } from "../planning/preparation-completion.js";
import { classifyReadinessIssue } from "../planning/preparation-checks.js";

const UNRESTRICTED_TOOLS = new Set([
  "read_product",
  "ask_user",
  "query_hotel_resource",
  "query_vehicle_resource",
  "query_station",
  "read_vbk_phase",
  "capture_itinerary_draft_save",
  "read_itinerary_draft_diagnostic",
]);

const TOOL_ACTION: Record<string, PreparationAction> = {
  patch_product: "patch_product",
  generate_product_module: "generate_product_module",
  query_poi: "query_poi",
  select_itinerary_poi: "select_itinerary_poi",
  resolve_itinerary_pois: "resolve_itinerary_pois",
  ensure_presentation_recommendations: "ensure_presentation_recommendations",
  resolve_cover: "resolve_cover",
  resolve_itinerary_hotels: "resolve_itinerary_hotels",
  resolve_vehicle_resource: "resolve_vehicle_resource",
  recheck_traffic_line_availability: "recheck_traffic_line_availability",
  request_approval: "request_approval",
};

const GENERATE_MAJOR: Record<string, PreparationMajorStage> = {
  skeleton: "foundation",
  basicInfo: "foundation",
  itinerary: "itinerary",
  presentation: "completion",
  commercial: "completion",
};

const FOUNDATION_OPERATIONS_KEYS = new Set([
  "transport",
  "pickupCity",
  "reusePickupForDropoff",
  "hotelSource",
  "hotelTier",
  "mealsIncluded",
  "bookingControls",
]);

const ITINERARY_TRAFFIC_LINE_KEYS = new Set(["arrivalCity", "departureCity"]);
const COMPLETION_OPERATIONS_KEYS = new Set(["trafficLine", "vehicleResource", "hotelResource"]);

export interface PreparationToolDenial {
  content: string;
  data: {
    preparationDenied: true;
    currentStage: PreparationMajorStage;
    currentNode: PreparationEvaluation["currentNode"];
    missing: string[];
    currentStageMissing: string[];
    laterStageMissing: string[];
  };
}

export function denyPreparationTool(
  product: ProductDetail,
  snapshot: AgentSnapshot | undefined,
  toolName: string,
  args: Record<string, unknown> = {},
): PreparationToolDenial | undefined {
  if (UNRESTRICTED_TOOLS.has(toolName)) return undefined;
  const evaluation = evaluatePreparationCompletion(product, snapshot);
  const action = TOOL_ACTION[toolName];
  const reason = actionDeniedReason(evaluation, toolName, action, args);
  if (!reason) return undefined;
  const payload = {
    ok: false,
    error: reason,
    currentStage: evaluation.currentStage,
    currentNode: evaluation.currentNode,
    missing: evaluation.missing,
    currentStageMissing: missingForCurrentStage(evaluation),
    laterStageMissing: missingForLaterStages(evaluation),
    allowedActions: evaluation.allowedActions,
  };
  return {
    content: JSON.stringify(payload),
    data: {
      preparationDenied: true,
      currentStage: evaluation.currentStage,
      currentNode: evaluation.currentNode,
      missing: evaluation.missing,
      currentStageMissing: missingForCurrentStage(evaluation),
      laterStageMissing: missingForLaterStages(evaluation),
    },
  };
}

function actionDeniedReason(
  evaluation: PreparationEvaluation,
  toolName: string,
  action: PreparationAction | undefined,
  args: Record<string, unknown>,
): string | undefined {
  const { currentStage, currentNode, missing, allowedActions } = evaluation;
  const currentMissing = missingForCurrentStage(evaluation);
  const laterMissing = missingForLaterStages(evaluation);
  const stay = `请留在 ${currentStage}/${currentNode} 继续补齐：${currentMissing.join("、") || "当前缺项"}`;
  const later = laterMissing.length ? `后续阶段待补：${laterMissing.join("、")}。` : "";
  if (action && !allowedActions.includes(action)) {
    return `当前阶段不允许 ${toolName}。${stay}${later}`;
  }
  if (toolName === "generate_product_module") {
    const stage = typeof args.stage === "string" ? args.stage : "";
    if (!generateStageAllowed(currentStage, stage, missing)) {
      return `当前处于 ${currentStage}/${currentNode}，不能执行 generate_product_module(${stage || "未知"}) 来跳过本阶段。${stay}${later}`;
    }
  }
  if (toolName === "patch_product") {
    const patch = args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
      ? args.patch as Record<string, unknown>
      : {};
    const blocked = blockedPatchFields(currentStage, patch);
    if (blocked.length) {
      return `当前处于 ${currentStage}，不能通过 ${blocked.join("、")} 绕过本阶段。${stay}${later}`;
    }
  }
  return undefined;
}

function missingForCurrentStage(evaluation: PreparationEvaluation): string[] {
  const current = evaluation.missing.filter((label) => classifyReadinessIssue(label, label).stage === evaluation.currentStage);
  return current.length ? current : evaluation.missing;
}

function missingForLaterStages(evaluation: PreparationEvaluation): string[] {
  const current = new Set(missingForCurrentStage(evaluation));
  return evaluation.missing.filter((label) => !current.has(label));
}

function generateStageAllowed(current: PreparationMajorStage, stage: string, missing: string[]): boolean {
  const major = GENERATE_MAJOR[stage];
  if (!major) return false;
  if (current === "foundation") return major === "foundation";
  if (current === "itinerary") return major === "itinerary";
  if (major !== "completion") return false;
  const text = missing.join(" ");
  if (stage === "presentation") return /封面|推荐|副标题|运营备注|特色/.test(text);
  if (stage === "commercial") return /套餐|定价|价格|库存|班期/.test(text);
  return false;
}

function blockedPatchFields(current: PreparationMajorStage, patch: Record<string, unknown>): string[] {
  if (current === "foundation") {
    return [
      ...Object.keys(patch).filter((key) => key !== "basicInfo" && key !== "operations"),
      ...blockedFoundationOperations(patch.operations),
    ];
  }
  if (current === "itinerary") {
    return [
      ...Object.keys(patch).filter((key) => key === "presentation" || key === "commercial"),
      ...blockedItineraryOperations(patch.operations),
    ];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function blockedFoundationOperations(operations: unknown): string[] {
  if (operations === undefined) return [];
  const record = asRecord(operations);
  if (!record) return ["operations"];
  return Object.keys(record)
    .filter((key) => !FOUNDATION_OPERATIONS_KEYS.has(key))
    .map((key) => `operations.${key}`);
}

function blockedItineraryOperations(operations: unknown): string[] {
  if (operations === undefined) return [];
  const record = asRecord(operations);
  if (!record) return ["operations"];
  const blocked: string[] = [];
  for (const key of Object.keys(record)) {
    if (key === "trafficLine") {
      blocked.push(...blockedItineraryTrafficLine(record.trafficLine));
      continue;
    }
    if (COMPLETION_OPERATIONS_KEYS.has(key)) blocked.push(`operations.${key}`);
  }
  return blocked;
}

function blockedItineraryTrafficLine(trafficLine: unknown): string[] {
  const record = asRecord(trafficLine);
  if (!record) return ["operations.trafficLine"];
  return Object.keys(record)
    .filter((key) => !ITINERARY_TRAFFIC_LINE_KEYS.has(key))
    .map((key) => `operations.trafficLine.${key}`);
}
