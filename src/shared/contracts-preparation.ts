import type { PlanningNodeId } from "./contracts-planning.js";

export const PREPARATION_PROMPT_VERSION = "vbk.preparation.v1";

export type PreparationMajorStage = "foundation" | "itinerary" | "completion";

export type ItineraryInputMode = "open" | "partial" | "complete";

export type PreparationAction =
  | "read_product"
  | "ask_user"
  | "patch_product"
  | "generate_product_module"
  | "query_poi"
  | "select_itinerary_poi"
  | "resolve_itinerary_pois"
  | "ensure_presentation_recommendations"
  | "resolve_cover"
  | "resolve_itinerary_hotels"
  | "resolve_vehicle_resource"
  | "recheck_traffic_line_availability"
  | "request_approval";

export interface LockedItineraryDay {
  day: number;
  spots: string[];
}

export interface LockedConstraints {
  destinationCity?: string;
  meetingCity?: string;
  days?: number;
  nights?: number;
  productForm?: string;
  transport?: string;
  hotelTier?: string;
  arrivalCity?: string;
  departureCity?: string;
  pois: string[];
  itineraryOrder: LockedItineraryDay[];
}

export interface PostApprovalDeterministicItem {
  id: string;
  label: string;
  reason: string;
}

export interface PreparationEvaluation {
  promptVersion: string;
  ready: boolean;
  currentStage: PreparationMajorStage;
  currentNode: PlanningNodeId;
  missing: string[];
  blockingReasons: string[];
  allowedActions: PreparationAction[];
  prohibitedActions: PreparationAction[];
  completionCriteria: string[];
  lockedConstraints: LockedConstraints;
  itineraryInputMode: ItineraryInputMode;
  postApprovalDeterministic: PostApprovalDeterministicItem[];
}
