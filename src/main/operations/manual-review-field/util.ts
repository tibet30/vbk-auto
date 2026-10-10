/**
 * manual-review-field 共用工具：
 *   - objectValue：防御式把 unknown 转成 object 记录，便于展开时少做 null 检查；
 *   - isIsoDate：校验 YYYY-MM-DD 字符串是否对应真实存在的日期；
 *   - repairLegacyCoverQuality：写完任何字段后顺手修复历史 cover minQuality 越界值。
 */

import type { ManualReviewFieldInput } from "../../../shared/contracts.js";

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

export function repairLegacyCoverQuality(product: Record<string, unknown>): Record<string, unknown> {
  const presentation = product.presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return product;
  const cover = (presentation as Record<string, unknown>).cover;
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) return product;
  const rawQuality = (cover as Record<string, unknown>).minQuality;
  const quality = Number(rawQuality);
  if (typeof rawQuality === "number" && Number.isFinite(rawQuality) && rawQuality >= 0 && rawQuality <= 5) return product;
  (presentation as Record<string, unknown>).cover = {
    ...(cover as Record<string, unknown>),
    minQuality: Number.isFinite(quality) && quality >= 0 && quality <= 5 ? quality : 3,
  };
  return product;
}

// ManualReviewFieldInput 在本文件中未直接使用（仅用于 cross-file 类型关系），导出供
// 拆解工具保持类型连通。
export type { ManualReviewFieldInput };