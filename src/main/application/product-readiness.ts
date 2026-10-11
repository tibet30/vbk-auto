import type { ProductReadiness } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { inspectManualCoverAsset } from "../automation/manual-cover-asset.js";
import { evaluateVisibleReadiness } from "../planning/preparation-completion.js";

export function evaluateMainReadiness(
  db: VbkDatabase,
  localProductId: string,
  options: {
    ignoreInterruptedAutomationFailure?: boolean;
    ignoreCurrentAutomationFailure?: boolean;
  } = {},
  inspectCover: typeof inspectManualCoverAsset = inspectManualCoverAsset,
): ProductReadiness {
  const product = db.getProduct(localProductId);
  if (!product) throw productNotFound(localProductId);
  const snapshot = db.getAgentSnapshot(localProductId);
  const visible = evaluateVisibleReadiness(product, snapshot, {
    ignoreInterruptedAutomationFailure: options.ignoreInterruptedAutomationFailure,
    ignoreCurrentAutomationFailure: options.ignoreCurrentAutomationFailure
      ?? Boolean(snapshot?.run && !snapshot?.uncertainWrite),
  });
  const issue = inspectCover(product.product).issue;
  if (!issue) return visible;
  const issues = [...visible.issues, { label: "封面图片规格", detail: issue }];
  return { ready: false, completion: Math.min(visible.completion, 92), issues };
}
