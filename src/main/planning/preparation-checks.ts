import type { PlanningNodeId } from "../../shared/contracts-planning.js";
import type { PreparationMajorStage, PostApprovalDeterministicItem } from "../../shared/contracts-preparation.js";
import { hasItineraryHotelStay } from "../../shared/itinerary-hotel.js";
import { requiresVehicleResource } from "../../shared/product-form.js";
import { hasSatisfiedVehicleResource } from "../../shared/research-task-satisfaction.js";
import { normaliseTrafficLineConfig } from "../../shared/contracts-traffic-line.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
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
  const meetingCity = toPlatformShortLocationName(textValue(basic?.meetingCity || basic?.destinationCity));
  const destinationCity = toPlatformShortLocationName(textValue(basic?.destinationCity || basic?.meetingCity));
  const days = Number(basic?.days);

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
    if (!lodgingDay || !hasItineraryHotelStay(lodgingDay.hotel)) continue;
    const candidates = asArray(lodgingDay.hotelCandidates) ?? [];
    if (candidates.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT || candidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT) {
      gaps.push({
        label: `酒店候选：第 ${Number(lodgingDay.day) || index + 1} 天`,
        detail: `住宿日必须先持久化 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT}–${HOTEL_RESOURCE_CANDIDATE_COUNT} 个携程酒店候选。`,
        stage: "completion",
        node: "hotelResolution",
      });
    }
  }

  if (requiresVehicleResource(sales?.productForm) && !hasSatisfiedVehicleResource(product)) {
    gaps.push({
      label: "用车资源组",
      detail: "私家团需要在本地准备阶段匹配用车资源组。",
      stage: "completion",
      node: "vehicleResource",
    });
  }

  const traffic = normaliseTrafficLineConfig(operations?.trafficLine);
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
  if (/每日行程|POI|suggestPoi|人工确认|手动录入/.test(text) || /景点/.test(label)) {
    return { stage: "itinerary", node: /每日行程/.test(label) ? "itineraryDraft" : "poiResolution" };
  }
  return { stage: "completion", node: "finalValidation" };
}
