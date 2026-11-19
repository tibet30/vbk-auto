import type { PlanningNodeId } from "../../../shared/contracts-planning.js";
import type { PreparationAction, PreparationEvaluation, PreparationGap, PreparationMajorStage } from "../../../shared/contracts-preparation.js";

const STAGE_ORDER: readonly PreparationMajorStage[] = ["foundation", "itinerary", "completion"];
const NODE_ORDER: readonly PlanningNodeId[] = [
  "skeleton", "spotCandidates", "itineraryDraft", "poiResolution", "hotelResolution",
  "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation",
];

export function preparationPosition(gaps: readonly PreparationGap[]) {
  const stage = STAGE_ORDER.find((value) => gaps.some((gap) => gap.stage === value));
  const stageGaps = stage ? gaps.filter((gap) => gap.stage === stage) : gaps;
  return {
    stage: stage ?? "completion",
    node: NODE_ORDER.find((value) => stageGaps.some((gap) => gap.node === value)) ?? stageGaps[0]?.node ?? "finalValidation",
  };
}

export function preparationActions(args: {
  stage: PreparationMajorStage;
  gaps: readonly PreparationGap[];
  ready: boolean;
  hasApproval: boolean;
  coverSearchExhausted: boolean;
}): { allowed: PreparationAction[]; prohibited: PreparationAction[] } {
  const { stage, gaps, ready, hasApproval, coverSearchExhausted } = args;
  const read: PreparationAction[] = ["read_product", "ask_user"];
  if (ready) {
    return hasApproval
      ? { allowed: [...read, "patch_product"], prohibited: ["request_approval", "generate_product_module"] }
      : { allowed: [...read, "patch_product", ...(!coverSearchExhausted ? ["resolve_cover" as const] : []), "request_approval"], prohibited: ["generate_product_module"] };
  }
  if (stage === "foundation") {
    return { allowed: [...read, "generate_product_module", "patch_product"], prohibited: ["request_approval"] };
  }
  if (stage === "itinerary") {
    return { allowed: [...read, "generate_product_module", "patch_product", "query_poi", "select_itinerary_poi", "resolve_itinerary_pois"], prohibited: ["request_approval"] };
  }
  const allowed: PreparationAction[] = [...read, "generate_product_module", "ensure_presentation_recommendations", "patch_product"];
  const codes = new Set(gaps.map((gap) => gap.code));
  if (!coverSearchExhausted && codes.has("cover")) allowed.push("resolve_cover");
  if (codes.has("hotel")) allowed.push("resolve_itinerary_hotels");
  if (codes.has("vehicle")) allowed.push("resolve_vehicle_resource");
  if (codes.has("traffic")) allowed.push("recheck_traffic_line_availability");
  return { allowed, prohibited: ["request_approval"] };
}

export function preparationStageGaps(evaluation: PreparationEvaluation): PreparationGap[] {
  const current = evaluation.gaps.filter((gap) => gap.stage === evaluation.currentStage);
  return current.length ? current : evaluation.gaps;
}

export function preparationGenerationAllowed(evaluation: PreparationEvaluation, stage: string): boolean {
  if (!evaluation.allowedActions.includes("generate_product_module")) return false;
  if (evaluation.currentStage === "foundation") return stage === "skeleton" || stage === "basicInfo";
  if (evaluation.currentStage === "itinerary") return stage === "itinerary";
  const codes = new Set(evaluation.gaps.map((gap) => gap.code));
  if (stage === "basicInfo") return codes.has("copy");
  if (stage === "presentation") return codes.has("copy") || codes.has("presentation") || codes.has("cover");
  if (stage === "commercial") return codes.has("commercial");
  return false;
}

export interface PreparationActionPlan {
  node: "itineraryDraft" | "poiResolution" | "hotelResolution" | "presentation";
  name: "generate_product_module" | "resolve_itinerary_pois" | "resolve_itinerary_hotels" | "ensure_presentation_recommendations";
  arguments: Record<string, unknown>;
}

/** Keep existing automatic actions; choices and approval stay with the durable Agent loop. */
export function preparationActionPlan(evaluation: PreparationEvaluation): PreparationActionPlan | undefined {
  if (evaluation.ready) return undefined;
  const actions: Partial<Record<PlanningNodeId, Omit<PreparationActionPlan, "node">>> = {
    itineraryDraft: { name: "generate_product_module", arguments: { stage: "itinerary" } },
    poiResolution: { name: "resolve_itinerary_pois", arguments: {} },
    hotelResolution: { name: "resolve_itinerary_hotels", arguments: {} },
    presentation: { name: "ensure_presentation_recommendations", arguments: {} },
  };
  const action = actions[evaluation.currentNode];
  if (!action || !evaluation.allowedActions.includes(action.name)) return undefined;
  return { node: evaluation.currentNode as PreparationActionPlan["node"], ...action };
}

/**
 * 同一 progressKey 下是否允许再执行一次。
 *
 * AI 生成有方差，同样的指纹再跑一次可能得到不同结果；POI 资源核验是同一份产品
 * 事实的确定性读取，指纹没变就必然得到同样的候选与未命中，重复执行只是把一整轮
 * POI 查询与 AI 裁决再付一次钱。
 */
export function preparationActionRepeatsOnNoProgress(name: PreparationActionPlan["name"]): boolean {
  return name !== "resolve_itinerary_pois";
}
