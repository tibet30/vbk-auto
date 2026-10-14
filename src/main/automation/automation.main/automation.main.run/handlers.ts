import { buildFillMap } from "../automation.main.run-one/fill-map.js";
import { executeDraftPhase } from "../runtime/phase.js";
import type { AutomationRunContext } from "../automation.main.context.js";
import type { AutomationSetup } from "./setup.js";

export { buildBasicExecute } from "../runtime/basic.js";

export function executeAutomationPhase(ctx: AutomationRunContext, setup: AutomationSetup,
  phase: string, productId: string, executeApi: () => Promise<unknown>) {
  return executeDraftPhase({ ctx, localProductId: setup.productDetail.id, run: setup.run,
    page: setup.page, productId, manualCover: setup.product.presentation?.cover?.source === "manualUpload",
    log: setup.log, persist: setup.persist }, phase, executeApi);
}

/** The same handlers are used for complete entry and a single-stage repair. */
export function buildAutomationHandlers(ctx: AutomationRunContext, setup: AutomationSetup,
  productIdRef: { current: string | undefined }): Record<string, () => Promise<unknown>> {
  const fillMap = buildFillMap({ ctx, localProductId: setup.productDetail.id,
    productDetail: setup.productDetail, page: setup.page, productData: setup.product,
    productId: productIdRef.current, run: setup.run, log: setup.log, persist: setup.persist,
    wizardAdvanceOnly: setup.wizardAdvanceOnly });
  return Object.fromEntries(Object.entries(fillMap).map(([phase, fill]) => [phase,
    () => executeAutomationPhase(ctx, setup, phase, productIdRef.current!, fill)]));
}
