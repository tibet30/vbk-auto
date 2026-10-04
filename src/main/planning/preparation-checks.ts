import type { PlanningNodeId } from "../../shared/contracts-planning.js";
import type { PreparationMajorStage, PostApprovalDeterministicItem } from "../../shared/contracts-preparation.js";
import { hasItineraryHotelStay } from "../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../shared/product-form.js";
import { hasSatisfiedVehicleResource } from "../../shared/research-task-satisfaction.js";
import { normaliseTrafficLineConfig } from "../../shared/contracts-traffic-line.js";
import { explicitlyDeclinesTrafficLine } from "../../shared/traffic-line-intent.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { hotelDiamondFromTier } from "../../shared/hotel-tiers.js";
import { hasPersistedCommercialInventory, hasPersistedCommercialPricing } from "./commercial-stage.js";

export interface PreparationGap {
  label: string;
  detail: string;
  stage: PreparationMajorStage;
  node: PlanningNodeId;
}

export const POST_APPROVAL_DETERMINISTIC: readonly PostApprovalDeterministicItem[] = [
  {
    id: "commercial.terms",
    label: "条款",
    reason: "条款仅在批准后由 VBK 条款页确定性生成，不能伪装成本地已完成",
  },
];

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function extraPreparationGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const basic = asObject(product.basicInfo);
  const sales = asObject(product.sales);
  const operations = asObject(product.operations);
  const commercial = asObject(product.commercial);
  const hotelDiamond = hotelDiamondFromTier(operations?.hotelTier);
  const meetingCity = toPlatformShortLocationName(textValue(basic?.meetingCity || basic?.destinationCity));
  const destinationCity = toPlatformShortLocationName(textValue(basic?.destinationCity || basic?.meetingCity));
  const days = Number(basic?.days);
  const nights = Number(basic?.nights);

  if (!meetingCity) {
    gaps.push({ label: "目的地", detail: "需锁定目的地城市后才能进入后续阶段。", stage: "foundation", node: "skeleton" });
  }
  if (!Number.isInteger(days) || days < 1) {
    gaps.push({ label: "出行天数", detail: "需锁定出行天数后才能规划行程。", stage: "foundation", node: "skeleton" });
  }
  if (meetingCity && destinationCity && meetingCity !== destinationCity) {
    gaps.push({
      label: "destinationCity",
      detail: "destinationCity 必须与已锁定 meetingCity 相同。",
      stage: "foundation",
      node: "skeleton",
    });
  }

  if (!textValue(commercial?.packageName)) {
    gaps.push({
      label: "套餐名称",
      detail: "本地准备阶段需生成套餐名称，不能等到 VBK 套餐页再补。",
      stage: "completion",
      node: "commercial",
    });
  }
  if (!hasPersistedCommercialPricing(commercial?.pricing)) {
    gaps.push({
      label: "定价",
      detail: "本地准备阶段需写入可审核的成人/儿童价和起订人数。",
      stage: "completion",
      node: "commercial",
    });
  }
  if (!hasPersistedCommercialInventory(commercial?.inventory)) {
    gaps.push({
      label: "库存班期",
      detail: "本地准备阶段需写入班期起止日期和每日配额。",
      stage: "completion",
      node: "commercial",
    });
  }

  const itinerary = asArray(product.itinerary) ?? [];
  for (const [index, day] of itinerary.entries()) {
    const lodgingDay = asObject(day);
    if (!lodgingDay || !needsItineraryHotelCandidates(lodgingDay, index, nights)) continue;
    const candidates = asArray(lodgingDay.hotelCandidates) ?? [];
    if (!hasValidItineraryHotelCandidates(candidates, hotelDiamond)) {
      gaps.push({
        label: `酒店候选：第 ${Number(lodgingDay.day) || index + 1} 天`,
        detail: `行程录入页使用携程平台酒店；住宿日必须先持久化 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT}–${HOTEL_RESOURCE_CANDIDATE_COUNT} 个含有效ID、城市、锚点、评分、距离且符合已锁定钻级的携程酒店候选，酒店资源阶段再录入真实酒店资源。`,
        stage: "completion",
        node: "hotelResolution",
      });
    }
  }

  if (productNeedsVehicleResource(product) && !hasSatisfiedVehicleResource(product)) {
    gaps.push({
      label: "用车资源组",
      detail: "已配置用车的产品需要在本地准备阶段匹配用车资源组。",
      stage: "completion",
      node: "vehicleResource",
    });
  }

  const traffic = normaliseTrafficLineConfig(operations?.trafficLine);
  if (explicitlyDeclinesTrafficLine(product) && traffic && (traffic.enabled || traffic.variants.length || traffic.availability)) {
    gaps.push({
      label: "大交通禁用配置",
      detail: "用户明确不录入大交通，需由受控核验入口清除错误启用的交通计划后再确认方案。",
      stage: "completion",
      node: "finalValidation",
    });
  }
  if (traffic?.enabled) {
    const available = new Set(traffic.availability?.availableVariants ?? []);
    const confirmed = traffic.variants.length > 0 && traffic.variants.every((variant) => available.has(variant));
    if (!traffic.availability || !confirmed) {
      gaps.push({
        label: "大交通端点可用性核验",
        detail: "已启用大交通时，必须先完成当前会话的端点可用性核验；同城不得被推断为不可售。",
        stage: "completion",
        node: "finalValidation",
      });
    }
  }
  return gaps;
}

function hasValidItineraryHotelCandidates(candidates: unknown[], requiredDiamond: number | undefined): boolean {
  if (candidates.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT || candidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT || !requiredDiamond) return false;
  return candidates.every((value) => {
    const candidate = asObject(value);
    return Boolean(candidate
      && Number.isInteger(candidate.hotelId) && Number(candidate.hotelId) > 0
      && textValue(candidate.hotelName)
      && typeof candidate.diamond === "number" && candidate.diamond === requiredDiamond
      && typeof candidate.score === "number" && Number.isFinite(candidate.score) && candidate.score >= 0
      && typeof candidate.distanceKm === "number" && Number.isFinite(candidate.distanceKm) && candidate.distanceKm >= 0
      && textValue(candidate.cityName)
      && textValue(candidate.anchorName)
      && Number.isInteger(candidate.anchorCityId) && Number(candidate.anchorCityId) > 0);
  });
}

function needsItineraryHotelCandidates(day: Record<string, unknown>, index: number, nights: number): boolean {
  if (hasItineraryHotelStay(day.hotel)) return true;
  if (textValue(day.hotel)) return false;
  return Number.isInteger(nights) && nights > 0 && index < nights;
}

export function classifyReadinessIssue(label: string, detail: string): Pick<PreparationGap, "stage" | "node"> {
  const text = `${label} ${detail}`;
  if (/省份|目的地|meetingCity|destinationCity|出行天数|hotelTier|pickupCity|骨架/.test(text)) {
    return { stage: "foundation", node: "skeleton" };
  }
  if (/酒店候选/.test(text)) return { stage: "completion", node: "hotelResolution" };
  if (/封面/.test(text)) return { stage: "completion", node: "cover" };
  if (/用车|资源组/.test(text)) return { stage: "completion", node: "vehicleResource" };
  if (/副标题|运营备注|产品特点/.test(text)) return { stage: "completion", node: "copy" };
  if (/推荐/.test(text)) return { stage: "completion", node: "presentation" };
  if (/套餐|定价|价格|库存|班期/.test(text)) return { stage: "completion", node: "commercial" };
  if (/大交通/.test(text)) return { stage: "completion", node: "finalValidation" };
  if (/itinerary|每日行程|POI|suggestPoi|人工确认|手动录入/.test(text) || /景点/.test(label)) {
    return { stage: "itinerary", node: /itinerary|每日行程/.test(label) ? "itineraryDraft" : "poiResolution" };
  }
  return { stage: "completion", node: "finalValidation" };
}
