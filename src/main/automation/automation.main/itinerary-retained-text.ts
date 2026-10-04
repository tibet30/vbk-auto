import { hasCompletePoi, requiresItineraryPoi, RETAINED_TEXT_ONLY_DETAIL_PATTERN, RETAINED_TEXT_ONLY_POI_REMARK } from "../../../shared/itinerary-activity-kind.js";
import { poiResearchTaskNames } from "../../../shared/poi-research-tasks.js";

type Task = { state: string; type?: string; label?: string; detail?: string };

/** 保留旧任务说明；标记不能免除真实 POI 校验，也不能重复追加。 */
export function materializeRetainedItinerary(product: Record<string, unknown>, tasks: readonly Task[]) {
  const names = new Set(tasks.filter(task =>
    (task.state === "confirmed" || task.state === "resolved") && RETAINED_TEXT_ONLY_DETAIL_PATTERN.test(task.detail || ""),
  ).flatMap(task => poiResearchTaskNames(task.label || "", task.type || "vbk")));
  const next = structuredClone(product);
  let changed = false;
  if (Array.isArray(next.itinerary)) for (const day of next.itinerary) {
    if (!day || !Array.isArray(day.spots)) continue;
    for (const spot of day.spots) {
      if (!spot || typeof spot !== "object" || hasCompletePoi(spot) || !requiresItineraryPoi(spot) || !names.has(spot.name)) continue;
      if (typeof spot.remark === "string" && spot.remark.includes(RETAINED_TEXT_ONLY_POI_REMARK)) continue;
      spot.remark = [spot.remark, RETAINED_TEXT_ONLY_POI_REMARK].filter(Boolean).join("；");
      changed = true;
    }
  }
  return { product: changed ? next : product, changed };
}
