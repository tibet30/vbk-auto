/**
 * 运营手工复核阶段里把单个字段（如成人 / 儿童价）写入 product JSON 的工具。
 * 仅依赖 shared 契约，不引入 VBK 浏览器，保持纯函数特性便于测试。
 */

import type { ManualReviewFieldInput } from "../../shared/contracts.js";

/**
 * 防御式地把 unknown 转成 object 记录，遇到 null / 非对象 / 数组都返回空对象，
 * 用于后续展开时不需要再做 null 检查。
 */
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 把 input 中的成人价 / 儿童价覆盖到 product.commercial.pricing，保持不修改原 product 的副本。
 *   - 价格范围校验：adult > 0、child >= 0；
 *   - 强制 currency = "CNY"；
 *   - 返回新 product，调用方决定是否落库或继续 merge。
 */
export function applyManualReviewField(product: Record<string, unknown>, input: ManualReviewFieldInput) {
  const next = structuredClone(product) as Record<string, unknown>;
  if (!Number.isFinite(input.adult) || input.adult <= 0) throw new Error("成人价必须大于 0。");
  if (!Number.isFinite(input.child) || input.child < 0) throw new Error("儿童价不能小于 0。");
  const commercial = objectValue(next.commercial);
  commercial.pricing = {
    ...objectValue(commercial.pricing),
    currency: "CNY",
    adult: input.adult,
    child: input.child,
  };
  next.commercial = commercial;
  return next;
}
