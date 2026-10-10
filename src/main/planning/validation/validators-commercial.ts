/**
 * deep 校验子模块 validator：commercial（packageName / pricing / inventory /
 * terms / release）+ skeleton（operations）。
 *   - packageName / pricing / inventory / terms / release 都从 product.commercial
 *     读字段；
 *   - skeleton 从 product.operations 读字段（hotelTier / pickupCity / transport）。
 *
 * 返回 null 表示该模块当前不参与校验（既不在 accepted 中也不在 product 中）。
 */

import { HOTEL_TIER_VALUES } from "../../../shared/hotel-tiers.js";
import type { ModuleOutcome } from "../../../shared/contracts-planning.js";
import { asArray, asRecord, textValue } from "./helpers.js";

export function validatePackageName(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.commercial) === undefined) return null;
  const commercial = asRecord(product.commercial);
  if (!commercial || textValue(commercial.packageName).length === 0) {
    return { module: "packageName", status: "rejected", reason: "packageName 缺失" };
  }
  return null;
}

export function validatePricing(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.commercial) === undefined) return null;
  const commercial = asRecord(product.commercial);
  const pricing = asRecord(commercial?.pricing);
  if (!pricing) return { module: "pricing", status: "rejected", reason: "pricing 缺失" };
  const reasons: string[] = [];
  if (pricing.currency !== "CNY") reasons.push("pricing.currency 必须是 CNY");
  if (!(typeof pricing.adult === "number" && pricing.adult > 0)) reasons.push("pricing.adult 必须 > 0");
  if (!(typeof pricing.child === "number" && pricing.child >= 0)) reasons.push("pricing.child 必须 ≥ 0");
  if (!(Number.isInteger(pricing.minimumTravelers) && (pricing.minimumTravelers as number) > 0)) reasons.push("pricing.minimumTravelers 必须是正整数");
  const cost = asRecord(pricing.cost);
  if (cost && typeof cost.adult === "number" && typeof pricing.adult === "number" && cost.adult > pricing.adult) {
    reasons.push("pricing.cost.adult 不可高于 pricing.adult");
  }
  if (!reasons.length) return null;
  return { module: "pricing", status: "rejected", reason: reasons.join("；") };
}

export function validateInventory(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.commercial) === undefined) return null;
  const commercial = asRecord(product.commercial);
  const inventory = asRecord(commercial?.inventory);
  if (!inventory) return { module: "inventory", status: "rejected", reason: "inventory 缺失" };
  const reasons: string[] = [];
  const startDate = textValue(inventory.startDate);
  const endDate = textValue(inventory.endDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) reasons.push("inventory.startDate 必须是 YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) reasons.push("inventory.endDate 必须是 YYYY-MM-DD");
  if (!Number.isInteger(inventory.dailyQuota) || (inventory.dailyQuota as number) < 1) reasons.push("inventory.dailyQuota 必须是正整数");
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    && new Date(startDate) > new Date(endDate)) {
    reasons.push("inventory.startDate 不可晚于 endDate");
  }
  if (!reasons.length) return null;
  return { module: "inventory", status: "rejected", reason: reasons.join("；") };
}

export function validateTerms(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.commercial) === undefined) return null;
  const commercial = asRecord(product.commercial);
  const terms = asRecord(commercial?.terms);
  if (!terms) return { module: "terms", status: "rejected", reason: "terms 缺失" };
  const missing = ["inclusions", "exclusions", "bookingNotes", "refundPolicy"].filter((key) => textValue(terms[key]).length === 0);
  if (!missing.length) return null;
  return { module: "terms", status: "rejected", reason: `terms 缺字段：${missing.join("、")}` };
}

export function validateRelease(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.commercial) === undefined) return null;
  const commercial = asRecord(product.commercial);
  const release = asRecord(commercial?.release);
  if (!release) return { module: "release", status: "rejected", reason: "release 缺失" };
  const reasons: string[] = [];
  if (!(typeof release.publicPriceCeiling === "number" && release.publicPriceCeiling > 0)) reasons.push("release.publicPriceCeiling 必须 > 0");
  // release.submitReview / publishAfterApproval：当前 schema 允许任意 boolean。
  // AI 自动写入路径仍由 stage-runner.sanitiseModuleValue 强制置 false，
  // 这里不再针对发布态单独发 invalid。
  if (!reasons.length) return null;
  return { module: "release", status: "rejected", reason: reasons.join("；") };
}

export function validateSkeleton(product: Record<string, unknown>, accepted: boolean): ModuleOutcome | null {
  if (!accepted && asRecord(product.operations) === undefined) return null;
  const operations = asRecord(product.operations);
  if (!operations) return { module: "skeleton", status: "rejected", reason: "operations 缺失" };
  const reasons: string[] = [];
  const hotelTier = textValue(operations.hotelTier);
  if (!(HOTEL_TIER_VALUES as readonly string[]).includes(hotelTier)) reasons.push("operations.hotelTier 不在白名单");
  if (textValue(operations.pickupCity).length === 0) reasons.push("operations.pickupCity 缺失");
  if (!["charter", "shared", "none"].includes(textValue(operations.transport))) reasons.push("operations.transport 不合法");
  if (!reasons.length) return null;
  return { module: "skeleton", status: "rejected", reason: reasons.join("；") };
}

// Reserved for future use: 把整个 commercial 子集批量校验。当前调用方按模块粒度校验，
// 这里保留 asArray 入口以便 deep 校验发现 commercial 缺失字段时统一抛出。
export function _unusedArrayHelper(): unknown[] | undefined {
  return asArray(undefined);
}