/**
 * deep 校验子模块 validator：basicInfo / itinerary / presentation。
 *   - 各自只暴露 validate + 不引入模块作用域状态；
 *   - 返回 void / ModuleOutcome 数组由调用方 deepValidateModules 合并。
 */

import { VBK_RECOMMENDATION_CATEGORIES } from "../../domain/product/recommendation-categories.js";
import { dayHasUserOtherActivity } from "../../../shared/itinerary-content.js";
import { hasCompletePoi, requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import { hasValidVbkRecommendationLength } from "../vbk-recommendation-length.js";
import type { ModuleOutcome } from "../../../shared/contracts-planning.js";
import { asArray, asRecord, textValue } from "./helpers.js";

export function validateBasic(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.basicInfo) === undefined) return null;
  const basic = asRecord(product.basicInfo);
  const reasons: string[] = [];
  for (const field of ["subtitle", "province", "operationNotes"]) {
    if (!textValue(basic?.[field])) reasons.push(`basicInfo.${field} 缺失`);
  }
  if (!reasons.length) return null;
  return { module: "basicInfo", status: "rejected", reason: reasons.join("；") };
}

export function validateItinerary(args: {
  product: Record<string, unknown>;
  expectedDays: number;
  accepted: boolean;
}): ModuleOutcome | null {
  if (!args.accepted && asArray(args.product.itinerary) === undefined) return null;
  const itinerary = asArray(args.product.itinerary) ?? [];
  const reasons: string[] = [];
  if (itinerary.length !== args.expectedDays) reasons.push(`行程天数 ${itinerary.length} ≠ 骨架天数 ${args.expectedDays}`);
  const seenDays = new Set<number>();
  let index = 0;
  for (const day of itinerary) {
    const record = asRecord(day);
    if (!record) { reasons.push(`第 ${index + 1} 天不是对象`); index += 1; continue; }
    const dayNum = Number(record.day);
    if (!Number.isInteger(dayNum) || dayNum < 1) {
      reasons.push(`第 ${index + 1} 天 day 字段不合法：${String(record.day)}`);
    } else {
      if (seenDays.has(dayNum)) reasons.push(`第 ${index + 1} 天 day=${dayNum} 重复`);
      seenDays.add(dayNum);
      if (dayNum !== index + 1) reasons.push(`第 ${index + 1} 天 day=${dayNum} 不是顺序递增`);
    }
    if (textValue(record.title).length === 0) reasons.push(`第 ${index + 1} 天 title 缺失`);
    const spots = asArray(record.spots);
    if (!spots || (spots.length === 0 && !dayHasUserOtherActivity(record))) {
      reasons.push(`第 ${index + 1} 天缺少已验证 spots 或用户其他活动`);
    } else {
      for (let spotIndex = 0; spotIndex < spots.length; spotIndex += 1) {
        const spot = asRecord(spots[spotIndex]);
        if (!spot) {
          reasons.push(`第 ${index + 1} 天第 ${spotIndex + 1} 个景点不是对象`);
          continue;
        }
        const label = textValue(spot.name) || textValue(spot.poiName) || `#${spotIndex + 1}`;
        if (requiresItineraryPoi(spot) && !hasCompletePoi(spot)) {
          if (!textValue(spot.poiName)) {
            reasons.push(`第 ${index + 1} 天第 ${spotIndex + 1} 个景点「${label}」缺 poiName 映射`);
          }
          if (!Number.isInteger(spot.poiId) || Number(spot.poiId) <= 0) {
            reasons.push(`第 ${index + 1} 天第 ${spotIndex + 1} 个景点「${label}」缺 poiId 映射`);
          }
        }
      }
    }
    if (textValue(record.description).length === 0) reasons.push(`第 ${index + 1} 天 description 缺失`);
    if (textValue(record.meals).length === 0) reasons.push(`第 ${index + 1} 天 meals 缺失`);
    index += 1;
  }
  if (!reasons.length) return null;
  return { module: "itinerary", status: "rejected", reason: reasons.join("；") };
}

export function validatePresentation(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.presentation) === undefined) return null;
  const presentation = asRecord(product.presentation);
  const reasons: string[] = [];
  if (!presentation) {
    reasons.push("presentation 不是对象");
  } else {
    const recommendations = asArray(presentation.recommendations);
    if (!recommendations) {
      reasons.push("recommendations 缺失");
    } else if (recommendations.length !== 3) {
      reasons.push(`recommendations 长度 ${recommendations.length} ≠ 3`);
    } else {
      const seen = new Set<string>();
      let valid = true;
      for (const [recommendationIndex, entry] of recommendations.entries()) {
        const record = asRecord(entry);
        const category = textValue(record?.category);
        if (!category) { reasons.push("recommendation.category 缺失"); valid = false; continue; }
        if (!(VBK_RECOMMENDATION_CATEGORIES as readonly string[]).includes(category)) {
          reasons.push(`recommendation.category=${category} 不在白名单`); valid = false;
        }
        if (seen.has(category)) { reasons.push(`recommendation.category=${category} 重复`); valid = false; }
        seen.add(category);
        const text = textValue(record?.text);
        if (text.length === 0) { reasons.push("recommendation.text 缺失"); valid = false; }
        else if (!hasValidVbkRecommendationLength(text)) {
          reasons.push(`recommendation[${recommendationIndex + 1}].text 不在 30～84 个字符范围内`);
          valid = false;
        }
      }
      if (!valid) { /* reasons already populated */ }
    }
    if (textValue(presentation.recommendation).length === 0) reasons.push("presentation.recommendation 缺失");
    if (textValue(presentation.features).length === 0) reasons.push("presentation.features 缺失");
    if (textValue(presentation.recommendationCategory).length === 0) reasons.push("presentation.recommendationCategory 缺失");
  }
  if (!reasons.length) return null;
  return { module: "presentation", status: "rejected", reason: reasons.join("；") };
}