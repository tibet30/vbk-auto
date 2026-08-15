/**
 * Recovery retry navigation: before rerunning a failed phase, reload a clean
 * product editor page for that phase so stale VBK DOM state does not leak into
 * the next attempt.
 */

import type { AdvisorAction } from "../../../shared/contracts.js";
import { productEditorUrl, productSectionUrl } from "../constants.js";

type RetryLog = (message: string, level?: "info" | "warning" | "error") => void;

const PHASE_SECTION: Record<string, string> = {
  basic: "basic",
  presentation: "presentation",
  itinerary: "itinerary",
  package: "packageManage",
  pricingInventory: "pricingInventory",
  hotelResource: "hotelResource",
  vehicleResource: "vehicleResource",
  terms: "terms",
};

export async function refreshPhasePageBeforeRetry(args: {
  page: {
    goto?: (url: string, options?: { waitUntil?: "domcontentloaded" }) => Promise<unknown>;
    reload?: (options?: { waitUntil?: "domcontentloaded" }) => Promise<unknown>;
    waitForLoadState?: (state: "networkidle", options?: { timeout?: number }) => Promise<unknown>;
  };
  productId?: string | null;
  phase: string;
  action: AdvisorAction;
  attempt: number;
  log: RetryLog;
}): Promise<void> {
  const { page, productId, phase, action, attempt, log } = args;
  if (!productId) {
    log(`phase=${phase} attempt=${attempt} retry refresh: productId 缺失，刷新当前页面`, "warning");
    await page.reload?.({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState?.("networkidle", { timeout: 5_000 }).catch(() => {});
    return;
  }

  const section = PHASE_SECTION[phase];
  const url = section ? productSectionUrl(productId, section) : productEditorUrl(productId);
  log(`phase=${phase} attempt=${attempt} retry refresh action=${action}`, "info");
  await page.goto?.(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState?.("networkidle", { timeout: 5_000 }).catch(() => {});
}
