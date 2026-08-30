/**
 * API phase page navigation. Every execution enters its target editor page;
 * recovery only records the retry so it cannot race that entry navigation.
 */

import type { AdvisorAction } from "../../../shared/contracts.js";
import { productSectionUrl } from "../constants.js";

type RetryLog = (message: string, level?: "info" | "warning" | "error") => void;

const PHASE_PAGE_SECTIONS: Record<string, string> = {
  basic: "basic",
  presentation: "presentation",
  itinerary: "itinerary",
  package: "packageManage",
  pricingInventory: "pricingInventory",
  hotelResource: "hotelResource",
  vehicleResource: "vehicleResource",
  terms: "terms",
  // preflight 没有独立编辑页；用基本信息页维持产品编辑器上下文。
  preflight: "basic",
};

type PhasePage = {
  goto: (url: string, options?: { waitUntil?: "domcontentloaded" }) => Promise<unknown>;
  reload: (options?: { waitUntil?: "domcontentloaded" }) => Promise<unknown>;
  waitForLoadState?: (state: "networkidle", options?: { timeout?: number }) => Promise<unknown>;
  url?: () => string;
};

function phasePageUrl(productId: string, phase: string): string {
  const section = PHASE_PAGE_SECTIONS[phase];
  if (!section) throw new Error(`未配置自动录入阶段页面：${phase}`);
  return productSectionUrl(productId, section);
}

async function waitForPhasePage(page: PhasePage, expectedUrl: string, phase: string): Promise<void> {
  if (page.waitForLoadState) {
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  }
  const actualUrl = page.url?.();
  if (actualUrl && new URL(actualUrl).pathname !== new URL(expectedUrl).pathname) {
    throw new Error(`phase=${phase} 未进入目标模块页面：${actualUrl}`);
  }
}

export async function enterPhasePageForApi(args: {
  page: PhasePage;
  productId?: string | null;
  phase: string;
  log: RetryLog;
  /**
   * 在 Electron BrowserView 中导航时必须走 VbkBrowser.navigate：它会临时
   * 放行 beforeunload，并把“已抵达目标但返回 ERR_ABORTED”视作成功。
   * 单元测试与无 BrowserView 的调用仍可回退到 Playwright page.goto。
   */
  navigate?: (url: string) => Promise<void>;
}): Promise<void> {
  const { page, productId, phase, log, navigate } = args;
  if (!productId) throw new Error(`phase=${phase} 缺少产品 ID，无法进入模块页面`);
  const url = phasePageUrl(productId, phase);
  log(`phase=${phase} 准备录入：进入模块页面`, "info");
  if (navigate) await navigate(url);
  else await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForPhasePage(page, url, phase);
}

export async function refreshPhasePageAfterApi(args: {
  page: PhasePage;
  productId?: string | null;
  phase: string;
  log: RetryLog;
}): Promise<void> {
  const { page, productId, phase, log } = args;
  // API handler 已完成远端回读后，页面仅用于让操作者看到最新状态。页面刷新
  // 不能反向否定已验证的业务写入（例如 BrowserView 路由中断、页面慢加载）。
  if (!productId) {
    log(`phase=${phase} API 远端回读完成，但缺少产品 ID，跳过页面刷新`, "warning");
    return;
  }
  const url = phasePageUrl(productId, phase);
  log(`phase=${phase} API 远端回读完成：刷新当前模块页面`, "info");
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPhasePage(page, url, phase);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`phase=${phase} API 远端回读已确认；页面刷新未完成，将在下次执行前重新进入目标页：${reason}`, "warning");
  }
}

export function recordPhaseRetry(args: {
  productId?: string | null;
  phase: string;
  action: AdvisorAction;
  attempt: number;
  log: RetryLog;
}): void {
  const { productId, phase, action, attempt, log } = args;
  log(
    `phase=${phase} attempt=${attempt} API retry action=${action} productId=${productId ?? "pending"}；下一次执行将在录入前进入模块页面`,
    "info",
  );
}
