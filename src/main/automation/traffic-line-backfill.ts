import type { ProductDetail } from "../../shared/contracts.js";

/** A newly restored traffic plan on a verified draft needs only the missing phase. */
export function needsTrafficLineBackfill(product: ProductDetail): boolean {
  if (!product.productId || product.automation?.status !== "succeeded") return false;
  if (product.automation.phases.some((phase) => phase.phase === "trafficLine")) return false;
  if (product.automation.phases.some((phase) => phase.status !== "completed")) return false;
  const operations = product.product.operations as { trafficLine?: { enabled?: boolean; variants?: unknown[] } } | undefined;
  const config = operations?.trafficLine;
  return config?.enabled === true && Array.isArray(config.variants) && config.variants.length > 0;
}
