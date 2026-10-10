/**
 * commercial.pricing / commercial.inventory 字段写入：
 *   - applyPricing：adult > 0、child >= 0、minimumTravelers 必须正整数；保留现有
 *     cost 子对象（只覆盖三字段，不误删运营此前填好的成本信息）；
 *   - applyInventory：startDate / endDate 必须合法 YYYY-MM-DD 且 start <= end；
 *     dailyQuota 必须正整数。
 */

import type { ManualReviewFieldInput } from "../../../shared/contracts.js";
import { isIsoDate, objectValue } from "./util.js";

export function applyPricing(product: Record<string, unknown>, adult: number, child: number, minimumTravelers: number): Record<string, unknown> {
  if (!Number.isFinite(adult) || adult <= 0) throw new Error("成人价必须大于 0。");
  if (!Number.isFinite(child) || child < 0) throw new Error("儿童价不能小于 0。");
  if (!Number.isInteger(minimumTravelers) || minimumTravelers <= 0) throw new Error("起订人数必须是大于 0 的整数。");
  const next = structuredClone(product) as Record<string, unknown>;
  const commercial = objectValue(next.commercial);
  const previousPricing = objectValue(commercial.pricing);
  // 显式保留 cost（成本）子对象：manual 三字段保存不应误删运营此前已经填好
  // 的成本信息；只把三字段（adult / child / minimumTravelers）覆盖写回。
  const nextPricing: Record<string, unknown> = {
    ...previousPricing,
    currency: "CNY",
    adult,
    child,
    minimumTravelers,
  };
  if (!("cost" in previousPricing)) {
    delete nextPricing.cost;
  }
  commercial.pricing = nextPricing;
  next.commercial = commercial;
  return next;
}

export function applyInventory(product: Record<string, unknown>, startDate: string, endDate: string, dailyQuota: number): Record<string, unknown> {
  const start = String(startDate ?? "").trim();
  const end = String(endDate ?? "").trim();
  if (!isIsoDate(start)) throw new Error("班期开始日期必须是 YYYY-MM-DD。");
  if (!isIsoDate(end)) throw new Error("班期结束日期必须是 YYYY-MM-DD。");
  if (start > end) throw new Error("班期开始日期不能晚于结束日期。");
  if (!Number.isInteger(dailyQuota) || dailyQuota <= 0) throw new Error("每日配额必须是正整数。");

  const next = structuredClone(product) as Record<string, unknown>;
  const commercial = objectValue(next.commercial);
  commercial.inventory = { startDate: start, endDate: end, dailyQuota };
  next.commercial = commercial;
  return next;
}

// ManualReviewFieldInput 在本文件中未直接使用，仅用于跨文件类型连通。
export type { ManualReviewFieldInput };