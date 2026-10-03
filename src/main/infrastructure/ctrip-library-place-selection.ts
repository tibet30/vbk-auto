import type { CtripLibraryPlaceCandidate } from "../../shared/contracts-types.js";

/** suggestPoi may rank unrelated popular attractions ahead of the exact keyword. */
export function selectAutomaticLibraryPlace(
  places: CtripLibraryPlaceCandidate[], keyword: string,
): CtripLibraryPlaceCandidate {
  const exact = places.filter(place => place.poiName.trim() === keyword.trim());
  if (exact.length > 1) throw new Error(`图库景点存在多个同名候选，请选择具体地址：${keyword}`);
  const selected = exact[0] ?? places[0];
  if (!selected) throw new Error(`suggestPoi 未找到匹配 POI：${keyword}`);
  return selected;
}
