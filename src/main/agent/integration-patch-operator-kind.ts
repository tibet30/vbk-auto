import type { ProductDetail } from "../../shared/contracts.js";
import { hasTrustedOperatorNonPoiClassification } from "../planning/itinerary-input-contract/utils.js";
import { asRecord, samePlace, spotName } from "../planning/itinerary-input-contract.js";

type Json = Record<string, unknown>;

/**
 * 运营已把查不到 POI 的条目改成自由活动 / 其他并结清核查任务后，Agent 的整天
 * spots 补丁不能把它写回景点类型；否则核查任务重开，运营要再处理一次。
 * 只沿用带 `[itinerary-kind:no-poi]` 运营凭证的同名条目，其余字段照补丁写入。
 */
export function keepOperatorNonPoiKinds(product: ProductDetail, days: Json[]): Json[] {
  const before = (Array.isArray(product.product.itinerary) ? product.product.itinerary : []).map(asRecord);
  return days.map((day) => {
    if (!Array.isArray(day.spots)) return day;
    const previousSpots = (before.find((item) => Number(item?.day) === Number(day.day))?.spots ?? []) as unknown[];
    const spots = day.spots.map((spot) => {
      const record = asRecord(spot);
      const name = record ? spotName(record) : "";
      if (!record || !name || !hasTrustedOperatorNonPoiClassification(product, Number(day.day), name)) return spot;
      const previous = previousSpots.map(asRecord).find((item) => item && samePlace(spotName(item), name));
      return previous?.kind && previous.kind !== record.kind ? { ...record, kind: previous.kind } : spot;
    });
    return { ...day, spots };
  });
}
