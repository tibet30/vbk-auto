import type { PreparationGap } from "../../../shared/contracts-preparation.js";

export function classifyReadinessIssue(label: string, detail: string): Pick<PreparationGap, "code" | "stage" | "node"> {
  const text = `${label} ${detail}`;
  if (/省份|目的地|meetingCity|destinationCity|出行天数|hotelTier|pickupCity|骨架/.test(text)) {
    return { code: "foundation", stage: "foundation", node: "skeleton" };
  }
  if (/酒店候选/.test(text)) return { code: "hotel", stage: "completion", node: "hotelResolution" };
  if (/封面/.test(text) || /^presentation\.cover(?:\.|$)/.test(label)) return { code: "cover", stage: "completion", node: "cover" };
  if (/用车|资源组/.test(text)) return { code: "vehicle", stage: "completion", node: "vehicleResource" };
  if (/副标题|运营备注|产品特点/.test(text)) return { code: "copy", stage: "completion", node: "copy" };
  if (/推荐|派生行程文案/.test(text)) return { code: "presentation", stage: "completion", node: "presentation" };
  if (/套餐|定价|价格|库存|班期/.test(text)) return { code: "commercial", stage: "completion", node: "commercial" };
  if (/大交通/.test(text)) return { code: "traffic", stage: "completion", node: "finalValidation" };
  if (/itinerary|每日行程|POI|suggestPoi|人工确认|手动录入/.test(text) || /景点/.test(label)) {
    return /itinerary|每日行程/.test(label)
      ? { code: "itinerary", stage: "itinerary", node: "itineraryDraft" }
      : { code: "poi", stage: "itinerary", node: "poiResolution" };
  }
  return { code: "validation", stage: "completion", node: "finalValidation" };
}
