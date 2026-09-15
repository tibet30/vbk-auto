import type { ProductSummary } from "../../../shared/contracts.js";
import type { AutomationRunContext } from "./automation.main.context.js";

export function writeAutomationProduct(
  ctx: AutomationRunContext,
  localProductId: string,
  product: Record<string, unknown>,
  status?: ProductSummary["status"],
): void {
  if (ctx.persistProduct) {
    ctx.persistProduct(localProductId, product, status);
    return;
  }
  ctx.db.updateProduct(localProductId, product, status);
}
