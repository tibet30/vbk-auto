import { VBK_RECOMMENDATION_CATEGORIES } from "../domain/product/recommendation-categories.js";
import { dayHasUserOtherActivity } from "../../shared/itinerary-content.js";
import { normaliseItinerarySupport } from "../../shared/itinerary-support-arrangements.js";
import { hasCompletePoi, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { hasValidVbkRecommendationLength } from "./vbk-recommendation-length.js";
import type { PlanningModule } from "../../shared/contracts-planning.js";

/**
 * 从持久化产品 JSON 反推「哪些模块已经落地」。
 *
 *  这是「真」的唯一来源；orchestrator 不依赖内存 accumulator。
 *
 *  - skeleton：operations.hotelTier / pickupCity / transport / mealsIncluded 都在；
 *  - presentation：对象存在 + recommendation + recommendations.length === 3 + 至少
 *    一条 category 命中白名单；
 *  - itinerary：数组非空 + 长度 = basicInfo.days + 每条 day 字段是 1..n 顺序递增
 *    + 每个 spot 都有平台 POI 映射（poiName + poiId）；
 *    旧浅实现只判断 length > 0，导致「2 天骨架 + 1 天行程」的非法产品被当作
 *    accepted 永久跳过，触发 false-success。骨架缺失时不放宽，仍然要求长度匹配；
 *  - packageName：commercial.packageName 非空；
 *  - pricing / inventory / release / terms：commercial.<key> 存在。
 */
export function detectAcceptedModulesFromProduct(product: Record<string, unknown>): PlanningModule[] {
  const accepted: PlanningModule[] = [];
  const basicInfo = product.basicInfo as Record<string, unknown> | undefined;
  if (basicInfo && typeof basicInfo.subtitle === "string" && basicInfo.subtitle.trim()
    && typeof basicInfo.province === "string" && basicInfo.province.trim()
    && typeof basicInfo.operationNotes === "string" && basicInfo.operationNotes.trim()) {
    accepted.push("basicInfo");
  }
  const operations = product.operations as Record<string, unknown> | undefined;
  if (
    operations
    && typeof operations === "object"
    && operations.hotelTier
    && operations.pickupCity
    && operations.transport
  ) {
    accepted.push("skeleton");
  }
  const presentation = product.presentation;
  if (presentation && typeof presentation === "object" && !Array.isArray(presentation)) {
    const p = presentation as Record<string, unknown>;
    if (typeof p.recommendation === "string" && p.recommendation.trim()
      && Array.isArray(p.recommendations) && p.recommendations.length === 3
      && typeof p.features === "string" && p.features.trim()
      && presentationRecommendationsValid(p.recommendations)) {
      accepted.push("presentation");
    }
  }
  const itinerary = product.itinerary;
  const expectedDays = Number.isInteger(Number(basicInfo?.days)) && Number(basicInfo?.days) > 0
    ? Number(basicInfo?.days)
    : null;
  if (Array.isArray(itinerary)) {
    if (expectedDays !== null) {
      if (itinerary.length === expectedDays && itineraryDaysAreOrdered(itinerary, expectedDays) && itineraryPoisAreComplete(itinerary)) {
        accepted.push("itinerary");
      }
    } else if (itinerary.length > 0 && itineraryDaysAreOrdered(itinerary, itinerary.length) && itineraryPoisAreComplete(itinerary)) {
      accepted.push("itinerary");
    }
  }
  const commercial = product.commercial as Record<string, unknown> | undefined;
  if (commercial && typeof commercial === "object") {
    if (typeof commercial.packageName === "string" && commercial.packageName.trim()) accepted.push("packageName");
    if (commercial.pricing && typeof commercial.pricing === "object" && !Array.isArray(commercial.pricing)) accepted.push("pricing");
    if (commercial.inventory && typeof commercial.inventory === "object" && !Array.isArray(commercial.inventory)) accepted.push("inventory");
    if (commercial.release && typeof commercial.release === "object" && !Array.isArray(commercial.release)) accepted.push("release");
  }
  return accepted;
}

/**
 * 验证 presentation.recommendations 三条都含合法 category / text：
 *   - 数组长度 = 3；
 *   - 每条 category 在 RECOMMENDATION_CATEGORIES 白名单里、text 非空；
 *   - 任何一条不合规 → 返回 false，整张 presentation 不算 accepted。
 */
function presentationRecommendationsValid(entries: unknown[]): boolean {
  let nonEmptyCategoryCount = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record.category !== "string" || !record.category.trim()) return false;
    if (!(VBK_RECOMMENDATION_CATEGORIES as readonly string[]).includes(record.category)) return false;
    if (typeof record.text !== "string" || !record.text.trim()) return false;
    if (!hasValidVbkRecommendationLength(record.text)) return false;
    nonEmptyCategoryCount += 1;
  }
  return nonEmptyCategoryCount === entries.length;
}

/**
 * 验证行程数组 days 字段是否 1..expectedDays 顺序递增且唯一：
 *   - 同时检查 record.day === index + 1，避免出现「2 天骨架 + 1 天行程」的非法产品；
 *   - 骨架缺失时不放宽（expectedDays==null 走调用方另一条分支）。
 */
function itineraryDaysAreOrdered(itinerary: unknown[], expectedDays: number): boolean {
  const seen = new Set<number>();
  for (let index = 0; index < expectedDays; index += 1) {
    const day = itinerary[index];
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    const record = day as Record<string, unknown>;
    const dayNum = Number(record.day);
    if (!Number.isInteger(dayNum) || dayNum < 1) return false;
    if (dayNum !== index + 1) return false;
    if (seen.has(dayNum)) return false;
    seen.add(dayNum);
  }
  return true;
}

export function itineraryPoisAreComplete(itinerary: unknown[]): boolean {
  if (itinerary.length === 0) return false;
  for (const day of itinerary) {
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    if (!Array.isArray((day as Record<string, unknown>).spots)) return false;
    const normalised = normaliseItinerarySupport(day);
    const spots = (normalised as Record<string, unknown>).spots as unknown[];
    if (spots.length === 0) {
      if (dayHasUserOtherActivity(day)) continue;
      return false;
    }
    for (const spot of spots) {
      if (!spot || typeof spot !== "object" || Array.isArray(spot)) return false;
      const record = spot as Record<string, unknown>;
      if (requiresItineraryPoi(record) && !hasCompletePoi(record)) return false;
    }
  }
  return true;
}

