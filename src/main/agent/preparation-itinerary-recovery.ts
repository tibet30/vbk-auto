import type { ProductDetail } from "../../shared/contracts.js";
import { hasCompletePoi } from "../../shared/itinerary-activity-kind.js";
import { poiResearchTaskNames } from "../../shared/poi-research-tasks.js";
import { selfRepairItineraryForVbk } from "../planning/itinerary-self-repair.js";
import { itineraryInputContractError } from "../planning/itinerary-input-contract.js";

/** Resume already verified local choices before asking the model to plan again. */
export function preparationItineraryRecovery(current: ProductDetail) {
  if (current.productId || !Array.isArray(current.product.itinerary)) return undefined;
  const basic = current.product.basicInfo as Record<string, unknown> | undefined;
  const repair = selfRepairItineraryForVbk(current.product.itinerary, Number(basic?.nights));
  if (!repair.changed || itineraryInputContractError(current, repair.itinerary)) return undefined;
  const resolvedNames = new Set([
    ...repair.removedTravelNodes,
    ...repair.selectedAlternatives.flatMap((item) => item.removed),
    ...repair.itinerary.flatMap((day) => Array.isArray(day.spots) ? day.spots
      .filter((spot) => spot && typeof spot === "object" && hasCompletePoi(spot))
      .map((spot) => spot.name) : []),
  ]);
  const taskIds = current.researchTasks.filter((task) => {
    const names = poiResearchTaskNames(task.label, task.type);
    return names.length > 0 && names.every((name) => resolvedNames.has(name));
  }).map((task) => task.id);
  return { product: { ...current.product, itinerary: repair.itinerary }, taskIds, repair };
}
