/**
 * itinerary-adoption state types 模块（用于解决 spots.ts ↔ state.ts 之间的
 * 类型循环 import）。
 *
 *   - RequiredItinerarySpot：{ dayIndex, spotIndex, name, travelNode }；
 *   - ItineraryAdoptionGuard：在 old POI 查询返回后核验 latest snapshot。
 */

export type RequiredItinerarySpot = {
  dayIndex: number;
  spotIndex: number;
  name: string;
  travelNode: boolean;
};

export type ItineraryAdoptionGuard = { ok: true } | { ok: false; reason: "itinerary_changed" | "adoption_state_changed" };