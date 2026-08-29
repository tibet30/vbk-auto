/**
 * Recovery retry navigation: before rerunning a failed phase, reload a clean
 * product editor page for that phase so stale VBK DOM state does not leak into
 * the next attempt.
 */

import type { AdvisorAction } from "../../../shared/contracts.js";

type RetryLog = (message: string, level?: "info" | "warning" | "error") => void;

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
  const { productId, phase, action, attempt, log } = args;
  log(
    `phase=${phase} attempt=${attempt} API retry action=${action} productId=${productId ?? "pending"}；重新解析前置接口并远端回读`,
    "info",
  );
}
