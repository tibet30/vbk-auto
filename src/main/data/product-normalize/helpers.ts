/**
 * product-normalize 的通用 helper：
 *   - textValue：归一字符串（trim）；
 *   - positiveNumberValue：> 0 的 Number；
 *   - positiveIntegerValue：>= 1 的整数；
 *   - normalisePoiId：把 unknown 归一为 POI ID（> 0 整数）或 null；
 *   - positiveNumber：把 unknown 转成非负有限数字；非法或负数返回 undefined；
 *   - positiveInteger：把 unknown 转成正整数（> 0）；非整数 / 非正返回 undefined。
 */

export function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveNumberValue(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

export function positiveIntegerValue(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

export function normalisePoiId(value: unknown): number | null {
  return positiveIntegerValue(value) ?? null;
}

/**
 * 把 unknown 转成非负有限数字；非法或负数返回 undefined。
 * 用于 pricing.cost.* / pricing.adult / release.publicPriceCeiling 等金额字段。
 */
export function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * 把 unknown 转成正整数（> 0）；非整数 / 非正返回 undefined。
 * 用于 inventory.dailyQuota / release.publicAuditRetries 等。
 */
export function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}