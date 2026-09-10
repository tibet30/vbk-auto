/**
 * 自动化契约 / readiness gate 的纯函数帮助集。
 * 与 automation-contract.ts 分离，避免单文件超过 350 行 size budget。
 *
 * 主要导出：
 *   - textValue / asObject / asArray：通用取值器；
 *   - hasValidPresentationRecommendations / hasValidPresentationText / hasValidItinerary
 *     / hasValidBasicInfoText / hasValidSkeleton / hasValidReleaseCeiling
 *     / isPrivateTour / isRecommendationItemValid：单字段 / 复合字段校验；
 *   - normalizePresentationContract：把产品 presentation 规整成「
 *     唯一可消费形态」，仅在断言失败时丢弃违规子字段。
 *
 * normalizePresentationContract 是「缺字段但显示旧 draft」场景下的核心：
 * 历史 product 的 presentation.recommendations 可能是 4 条 / 重复 category，
 * 不在主路径落库前自动修正（避免「AI 编出假数据」），但 readiness 阶段必须
 * 识别为未就绪。
 */

import { HOTEL_TIER_VALUES } from "../../shared/hotel-tiers.js";
import { RECOMMENDATION_CATEGORIES } from "./schema/schema-definitions.js";
import { readCover } from "../operations/cover-info.js";
import { isCtripLibraryCoverComplete } from "../operations/cover-auto-fill.js";
import { dayHasUserOtherActivity } from "../../shared/itinerary-content.js";

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function isRecommendationItemValid(value: unknown): boolean {
  const record = asObject(value);
  if (!record) return false;
  const category = textValue(record.category);
  const text = textValue(record.text);
  if (!category || !text) return false;
  return (RECOMMENDATION_CATEGORIES as readonly string[]).includes(category);
}

/**
 * presentation.recommendations 完整性校验：
 *   - 数组长度 = 3；
 *   - 每条 category 命中白名单、text 非空；
 *   - 任意两条 category 相同 → false。
 * 用于 readiness + 防御深度闸门。
 */
export function hasValidPresentationRecommendations(product: Record<string, unknown>): boolean {
  const presentation = asObject(product.presentation);
  if (!presentation) return false;
  const recommendations = asArray(presentation.recommendations);
  if (!recommendations || recommendations.length !== 3) return false;
  const seen = new Set<string>();
  for (const entry of recommendations) {
    if (!isRecommendationItemValid(entry)) return false;
    const category = textValue((entry as Record<string, unknown>).category);
    if (seen.has(category)) return false;
    seen.add(category);
  }
  return true;
}

export function hasValidPresentationText(product: Record<string, unknown>): boolean {
  const presentation = asObject(product.presentation);
  if (!presentation) return false;
  return textValue(presentation.recommendation).length > 0
    && textValue(presentation.features).length > 0;
}

export function hasValidItinerary(product: Record<string, unknown>): boolean {
  const itinerary = asArray(product.itinerary);
  if (!itinerary || itinerary.length === 0) return false;
  for (const day of itinerary) {
    const record = asObject(day);
    if (!record) return false;
    if (textValue(record.title).length === 0) return false;
    if (textValue(record.description).length === 0) return false;
    if (textValue(record.meals).length === 0) return false;
    const spots = asArray(record.spots);
    if (!spots) return false;
    if (spots.length === 0) {
      if (dayHasUserOtherActivity(record)) continue;
      return false;
    }
    for (const spot of spots) {
      const item = asObject(spot);
      if (!item || textValue(item.name).length === 0) return false;
      if (textValue(item.poiName).length === 0) return false;
      if (!Number.isInteger(item.poiId) || Number(item.poiId) <= 0) return false;
    }
  }
  return true;
}

export function hasValidBasicInfoText(product: Record<string, unknown>): boolean {
  const basic = asObject(product.basicInfo);
  if (!basic) return false;
  return textValue(basic.subtitle).length > 0
    && textValue(basic.province).length > 0
    && textValue(basic.operationNotes).length > 0;
}

export function hasValidSkeleton(product: Record<string, unknown>): boolean {
  const operations = asObject(product.operations);
  if (!operations) return false;
  const tier = textValue(operations.hotelTier);
  if (!(HOTEL_TIER_VALUES as readonly string[]).includes(tier)) return false;
  if (textValue(operations.pickupCity).length === 0) return false;
  if (!["charter", "shared", "none"].includes(textValue(operations.transport))) return false;
  return true;
}

export function isPrivateTour(product: Record<string, unknown>): boolean {
  const sales = asObject(product.sales);
  return sales?.productForm === "privateTour";
}

export function hasValidReleaseCeiling(product: Record<string, unknown>): boolean {
  const commercial = asObject(product.commercial);
  if (!commercial) return true; // 缺 release 不阻断（自动草稿态默认安全）
  const release = asObject(commercial.release);
  if (!release) return true;
  return typeof release.publicPriceCeiling === "number" && release.publicPriceCeiling > 0;
}

/**
 * presentation 封面是否已经选定一张可写入的图。
 *
 * ctripLibrary 的 POI 只是检索锚点，不是封面本身；必须已有具体 imageId 和
 * imageUrl，且仍与已核验行程 POI 一致，才能进入最终确认。manualUpload 由
 * automationBlockers 专门报告「不可自动化」语义，此处不重复阻塞。
 */
export function hasValidCoverPoMeta(product: Record<string, unknown>): boolean {
  const cover = readCover(product);
  if (!cover) return false;
  if (cover.source === "manualUpload") return true;
  const presentation = asObject(product.presentation);
  const rawCover = asObject(presentation?.cover);
  if (!isCtripLibraryCoverComplete(rawCover)) return false;
  const coverPoi = textValue(cover.poi);
  if (!coverPoi) return false;
  const itinerary = asArray(product.itinerary) ?? [];
  const spots = itinerary.flatMap((day) => asArray(asObject(day)?.spots) ?? [])
    .map(asObject)
    .filter((spot): spot is Record<string, unknown> => Boolean(spot));
  if (!spots.length) return false;
  const coverPoiId = Number(cover.poiId);
  if (Number.isInteger(coverPoiId) && coverPoiId > 0) {
    return spots.some((spot) => Number(spot.poiId) === coverPoiId);
  }
  return spots.some((spot) => {
    const names = [textValue(spot.poiName), textValue(spot.name)].filter(Boolean);
    return names.some((name) => name === coverPoi || name.includes(coverPoi) || coverPoi.includes(name));
  });
}
