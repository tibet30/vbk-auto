/**
 * product-normalize/commercial 子模块：商业字段归一化（pricing / inventory / release）。
 *
 *   - normaliseCommercialPricing：adult > 0、child ≥ 0、minimumTravelers 为正整数、currency 仅允许 CNY；
 *     含 cost.{adult, child} 与可选 singleSupplement / childBed。
 *     任一关键字段不合规 → 返回 undefined。
 *   - normaliseCommercialInventory：startDate / endDate 必须是 YYYY-MM-DD，dailyQuota 为正整数，
 *     且 startDate 不晚于 endDate，否则返回 undefined。
 *   - normaliseCommercialRelease：publicPriceCeiling 必填（>0）；
 *     默认保留人工/VBK 已打开的 submitReview / publishAfterApproval；
 *     options.safeRelease=true 时强制 draft-only（AI / 自动写入路径）；
 *     publicAuditRetries 钳制到 1..10，超出回落到 3。
 */

import { positiveInteger, positiveNumber } from "./helpers.js";
import type { NormaliseReleaseOptions } from "./types.js";

/**
 * 商业定价归一化：adult > 0、child ≥ 0、minimumTravelers 为正整数、currency 仅允许 CNY；
 * 含 cost.{adult, child} 与可选 singleSupplement / childBed。
 * 任一关键字段不合规 → 返回 undefined。
 */
export function normaliseCommercialPricing(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const adult = positiveNumber(record.adult);
  const child = positiveNumber(record.child);
  const minimumTravelers = positiveInteger(record.minimumTravelers);
  if (adult === undefined || adult <= 0 || child === undefined || minimumTravelers === undefined) return undefined;
  const currency = record.currency === "CNY" || record.currency === undefined ? "CNY" : undefined;
  if (!currency) return undefined;
  const costSource = record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? record.cost as Record<string, unknown> : undefined;
  const cost = costSource ? (() => {
    const adultCost = positiveNumber(costSource.adult);
    const childCost = positiveNumber(costSource.child);
    if (adultCost === undefined || childCost === undefined) return undefined;
    const single = positiveNumber(costSource.singleSupplement) ?? 0;
    const bed = positiveNumber(costSource.childBed) ?? 0;
    return { adult: adultCost, child: childCost, singleSupplement: single, childBed: bed };
  })() : undefined;
  const out: Record<string, unknown> = { currency, adult, child, minimumTravelers };
  if (cost) out.cost = cost;
  return out;
}

/**
 * 库存归一化：startDate / endDate 必须是 YYYY-MM-DD，dailyQuota 为正整数，
 * 且 startDate 不晚于 endDate，否则返回 undefined。
 */
export function normaliseCommercialInventory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const start = typeof record.startDate === "string" ? record.startDate : "";
  const end = typeof record.endDate === "string" ? record.endDate : "";
  const quota = positiveInteger(record.dailyQuota);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !quota) return undefined;
  if (new Date(start) > new Date(end)) return undefined;
  return { startDate: start, endDate: end, dailyQuota: quota };
}

/**
 * Release 归一化：
 *   - publicPriceCeiling 必填（>0）；
 *   - 默认保留人工/VBK 已打开的 submitReview / publishAfterApproval；
 *   - options.safeRelease=true 时强制 draft-only（AI / 自动写入路径）；
 *   - publicAuditRetries 钳制到 1..10，超出回落到 3。
 */
export function normaliseCommercialRelease(value: unknown, options?: NormaliseReleaseOptions) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ceiling = positiveNumber(record.publicPriceCeiling);
  if (!ceiling) return undefined;
  // 通用语义：默认**保留** release.submitReview / publishAfterApproval；
  // 这是数据库启动归一、历史 fixture 解析、读取已人工显式打开的 release
  // 时的安全路径——一次 reload 不应把运营/VBK 标记的发布态悄悄翻成 false。
  // AI / 自动写入路径必须显式传 safeRelease=true 来强制 draft-only。
  const safe = options?.safeRelease === true;
  const submitReview = safe ? false : record.submitReview === true;
  const publishAfterApproval = safe ? false : record.publishAfterApproval === true;
  const retriesRaw = positiveInteger(record.publicAuditRetries);
  const publicAuditRetries = retriesRaw && retriesRaw >= 1 && retriesRaw <= 10 ? retriesRaw : 3;
  return {
    submitReview,
    publishAfterApproval,
    publicPriceCeiling: ceiling,
    publicAuditRetries,
  };
}