import type { ProductSummary } from "./contracts-types.js";

/** 已收敛的历史任务会指向实际通过远端回读的新草稿。 */
export function replacementDraftProductId(product: Pick<ProductSummary, "workflowTask"> | null | undefined): string | undefined {
  const message = product?.workflowTask?.message ?? "";
  const match = message.match(/^已由新草稿\s+(\d+)\s+接管；/);
  return match?.[1];
}
