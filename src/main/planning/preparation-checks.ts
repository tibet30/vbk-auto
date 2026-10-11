/** Preparation checks retain their public path; each domain owns its invariants. */
import type { ProductDetail } from "../../shared/contracts.js";
import type { PreparationGap, PostApprovalDeterministicItem } from "../../shared/contracts-preparation.js";
import { foundationGaps } from "./preparation-checks/foundation.js";
import { commercialGaps } from "./preparation-checks/commercial.js";
import { itineraryCopyGaps } from "./preparation-checks/copy.js";
import { resourceGaps } from "./preparation-checks/resources.js";
import { trafficGaps } from "./preparation-checks/traffic.js";

export type { PreparationGap } from "../../shared/contracts-preparation.js";
export { classifyReadinessIssue } from "./preparation-checks/classification.js";

export const POST_APPROVAL_DETERMINISTIC: readonly PostApprovalDeterministicItem[] = [
  {
    id: "commercial.terms",
    label: "条款",
    reason: "条款仅在批准后由 VBK 条款页确定性生成，不能伪装成本地已完成",
  },
];

export function extraPreparationGaps(product: Record<string, unknown>, detail?: ProductDetail): PreparationGap[] {
  return [
    ...foundationGaps(product),
    ...commercialGaps(product),
    ...itineraryCopyGaps(detail),
    ...resourceGaps(product),
    ...trafficGaps(product),
  ];
}
