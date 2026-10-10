import type { ProductDetail } from "../../shared/contracts.js";
import type { TrafficLineConfig } from "../../shared/contracts-traffic-line.js";
import { incompleteTrafficVariants } from "../../shared/traffic-resource-status.js";

/** A newly restored traffic plan on a verified draft needs only the missing phase. */
export function needsTrafficLineBackfill(product: ProductDetail): boolean {
  if (!product.productId || product.automation?.status !== "succeeded") return false;
  const trafficPhase = product.automation.phases.find((phase) => phase.phase === "trafficLine");
  if (product.automation.phases.some((phase) => phase.phase !== "trafficLine" && phase.status !== "completed")) return false;
  const operations = product.product.operations as { trafficLine?: { enabled?: boolean; variants?: unknown[] } } | undefined;
  const config = operations?.trafficLine;
  if (config?.enabled !== true || !Array.isArray(config.variants) || !config.variants.length) return false;
  if (trafficPhase?.status !== "completed") return true;
  // Optional traffic failures can leave the parent succeeded and the phase
  // completed. A recoverable child still needs its existing checkpoint resumed.
  return incompleteTrafficVariants(config as TrafficLineConfig, product.automation.trafficLine).length > 0;
}
