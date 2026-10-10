/**
 * itinerary-adoption 共用工具：
 *   - asRecord / text / positiveInteger / normaliseMentionText；
 *   - invalidateItineraryNode：把 plan 节点 status 归零（attempts=0、清空
 *     startedAt / completedAt / error / summary），用作 mark* 函数的原子；
 *   - SETTLEMENT_NODE_NAMES / ITINERARY_NODES / COMPLETION_NODES / HOTEL_RESOLUTION_NODE
 *     节点名集合。
 */

import type { PlanningNodeId, PlanningPlanV2 } from "../../../shared/contracts-planning.js";

export const COMPLETION_NODES = new Set<PlanningNodeId>([
  "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation",
]);
export const ITINERARY_NODES = new Set<PlanningNodeId>(["poiResolution", "itineraryDraft"]);
export const HOTEL_RESOLUTION_NODE: PlanningNodeId = "hotelResolution";
export const SETTLEMENT_NODE_NAMES = new Set(["四姑娘山镇", "新都桥镇"]);

export function invalidateItineraryNode(node: PlanningPlanV2["nodes"][number]) {
  return {
    ...node,
    status: "invalidated" as const,
    attempts: 0,
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    summary: undefined,
  };
}

export function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function normaliseMentionText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]·—_-]+/g, "");
}