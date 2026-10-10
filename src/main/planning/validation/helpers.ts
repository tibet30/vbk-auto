/**
 * deepValidateModules 内部共用工具：
 *   - textValue：把任意 unknown 安全转成已 trim 的字符串；
 *   - asRecord：unknown → plain record（排除 null / 数组 / 原始类型）；
 *   - asArray：unknown → 数组（非数组返回 undefined），用于遍历校验。
 *
 * deep 校验时这些工具复用率很高，集中放在 helpers 里避免每个 validator 复制。
 */

import type { PlanningModule } from "../../../shared/contracts-planning.js";

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * 「模块在 product 里存在」是 deep validation 的真实触发条件；acceptedSet
 * 只是「当前被认可为合法」的缓存。resume 路径下，运营 / 手工可能把曾经合法
 * 的 itinerary 改坏，acceptedSet 会因为 shallow detection 不同意而不再含
 * itinerary；但产品里 itinerary 数组仍在，必须仍然 deep-validate 以触发
 * rewind。这避免「非法产品长期处于 completed 状态」的回归。
 */
export function productHasModule(product: Record<string, unknown>, module: PlanningModule): boolean {
  switch (module) {
    case "basicInfo": return asRecord(product.basicInfo) !== undefined;
    case "itinerary": return asArray(product.itinerary) !== undefined;
    case "presentation": return asRecord(product.presentation) !== undefined;
    case "packageName":
    case "pricing":
    case "inventory":
    case "terms":
    case "release":
      return asRecord(product.commercial) !== undefined
        && asRecord((product.commercial as Record<string, unknown>)[module]) !== undefined;
    case "skeleton":
      return asRecord(product.operations) !== undefined;
    case "researchTasks":
      return false;
  }
}