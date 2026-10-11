import { logInfo } from "../../../shared/log-timestamp.js";
import { bestResourceGroup } from "./parse.js";
import type { VehicleResourceQuery } from "./types.js";

/** Queries do not mutate products; provider failures propagate instead of becoming empty matches. */
export async function matchVehicleResource(
  estimate: VehicleResourceQuery,
  targetTotalCost: number | undefined,
  search: (query: string) => Promise<unknown>,
) {
  const primaryQuery = targetTotalCost ? `${estimate.query}${targetTotalCost}` : estimate.query;
  const payload = await search( primaryQuery);
  // 如果精准查询无结果，退而求其次用更宽泛的关键词重试（去掉车级）。
  let selected = bestResourceGroup(payload, targetTotalCost, estimate.query);
  let matchedQuery = primaryQuery;
  if (!selected) {
    const fallbackQuery = `${estimate.seats}座`; // 去掉车级（经济/舒适），只用座位数
    if (fallbackQuery !== estimate.query) {
      const fallbackSearchQuery = targetTotalCost ? `${fallbackQuery}${targetTotalCost}` : fallbackQuery;
      const fallbackPayload = await search( fallbackSearchQuery);
      selected = bestResourceGroup(fallbackPayload, targetTotalCost, estimate.query);
      if (selected) {
        matchedQuery = fallbackSearchQuery;
        logInfo("[VehicleResource] matched via fallback query", { original: primaryQuery, fallback: fallbackSearchQuery, resourceGroupId: selected.resourceGroupId });
      }
    }
  }
  return { estimate, targetTotalCost, primaryQuery, matchedQuery, selected };
}
