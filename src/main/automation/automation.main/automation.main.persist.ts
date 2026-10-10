import type { ProductSummary } from "../../../shared/contracts.js";
import type { AutomationRunContext } from "./automation.main.context.js";

export function writeAutomationProduct(
  ctx: AutomationRunContext,
  localProductId: string,
  product: Record<string, unknown>,
  status?: ProductSummary["status"],
): void {
  // The platform schema drops local diagnostics. Its parsed output must not
  // erase durable route verification or creation evidence when written back.
  const current = ctx.db.getProduct(localProductId)?.product;
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const diagnostics = { ...record(product.diagnostics), ...record(current?.diagnostics) };
  const next = Object.keys(diagnostics).length ? { ...product, diagnostics } : product;
  if (ctx.persistProduct) {
    ctx.persistProduct(localProductId, next, status);
    return;
  }
  ctx.db.updateProduct(localProductId, next, status);
}
