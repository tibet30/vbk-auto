import type { ProductSummary } from "../../../shared/contracts-types.js";

/**
 * 用 updated 替换列表中同 id 的项并移到首位。
 * 若列表中不存在该 id，返回原数组引用（不插入已删除/迟到的项）。
 */
export function upsertProductToTop(
  products: ProductSummary[],
  updated: ProductSummary,
): ProductSummary[] {
  const idx = products.findIndex((p) => p.id === updated.id);
  if (idx === -1) return products;
  const current = products[idx];
  return [{ ...updated, workflowTask: updated.workflowTask ?? current.workflowTask }, ...products.slice(0, idx), ...products.slice(idx + 1)];
}
