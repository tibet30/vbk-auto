/**
 * itinerary-input-contract 输入模式分类：
 *   - classifyItineraryInputMode：基于 LockedConstraints + PlanningUserIntent
 *     判断 itinerary 改写属于 complete / partial / open：
 *       complete：用户已给出完整行程（intent.completeDailyUserItinerary 或
 *         coversAllDays 锁定 order 全覆盖 days）；
 *       partial：用户给出至少一个 poi / day activity / 一个 day 的 order 锁定；
 *       open：没有锁定，直接 AI 规划。
 *   - coversAllDays：order.spots 全 days 都有内容才算"覆盖完整"。
 */

import type { PlanningUserIntent } from "../../../shared/contracts-planning-intent.js";
import type { ItineraryInputMode, LockedConstraints, LockedItineraryDay } from "../../../shared/contracts-preparation.js";
import { hasCompleteDailyUserItinerary } from "../user-intent.js";

export function classifyItineraryInputMode(
  locked: LockedConstraints,
  days: number,
  intent?: PlanningUserIntent,
): ItineraryInputMode {
  if ((intent && hasCompleteDailyUserItinerary(intent, days)) || coversAllDays(locked.itineraryOrder, days)) {
    return "complete";
  }
  if (locked.pois.length || locked.itineraryOrder.length || (intent?.activities.some((activity) => activity.kind === "poi" || activity.day > 0))) {
    return "partial";
  }
  return "open";
}

export function coversAllDays(order: LockedItineraryDay[], days: number): boolean {
  if (days < 1 || !order.length) return false;
  const planned = new Set(order.filter((row) => row.spots.length).map((row) => row.day));
  return Array.from({ length: days }, (_, index) => planned.has(index + 1)).every(Boolean);
}