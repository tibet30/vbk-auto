/**
 * vehicle-resource.ts 的通用工具：
 *   - positiveInteger / positiveNumber：unknown → 安全整数；
 *   - roundUpVehicleTotalCost：把目标价格按 50 元向上取整；
 *   - textValue / firstText / firstNumber：从 record 多个候选 key 中按顺序取第一个有效值；
 *   - escapeRegExp / normalisedText：名称归一 + 字符串正则转义（解析价格用）。
 *
 * 子模块（query / parse / search / resolve）都依赖这些低层工具。
 */

export function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

export function positiveNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

export function roundUpVehicleTotalCost(value: number) {
  return Math.ceil(value / 50) * 50;
}

/** 把 unknown 转成 trim 后的字符串，非字符串返回 ""。 */
export function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 从 record 的多个候选 key 中按顺序取第一个非空字符串。
 */
export function firstText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * 从 record 的多个候选 key 中按顺序取第一个正整数。
 */
export function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = positiveInteger(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalisedText(value: string) {
  return value.replace(/\s+/g, "");
}