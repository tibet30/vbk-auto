import { BrowserWindow } from "electron";
import type { AutomationRun, ContactCardSelection } from "../../../shared/contracts.js";
import type { ActiveButlerContext } from "./automation.main.context.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";

export function resolveButlerSelection(db: VbkDatabase, accountName: string | undefined): ContactCardSelection | null {
  if (!accountName) return null;
  const info = db.getAccountFixedInfo(accountName);
  const butler = info.values.butlerName;
  return butler && typeof butler === "object" ? butler : null;
}

export function resolveServicePhone(db: VbkDatabase, accountName: string | undefined): string | null {
  if (!accountName) return null;
  const info = db.getAccountFixedInfo(accountName);
  const phone = info.values.servicePhone;
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  return trimmed || null;
}

export function resolveActiveButlerContext(
  db: VbkDatabase,
  accountName?: string,
): ActiveButlerContext | null {
  const isReady = (name: string) => {
    const butlerSelection = resolveButlerSelection(db, name);
    const servicePhone = resolveServicePhone(db, name);
    if (!butlerSelection || !servicePhone) return null;
    return { accountName: name, butlerSelection, servicePhone, fallbackUsed: false };
  };

  if (accountName) {
    const direct = isReady(accountName);
    if (direct) return direct;
  }

  const known = db.listKnownAccounts().map((item) => item.accountName);
  for (const name of known) {
    if (accountName && name === accountName) continue;
    const fallback = isReady(name);
    if (fallback) {
      console.warn(
        `[automation] 当前 vbkAccountName "${accountName || "<空>"}" 未匹配到有效固定信息，回退到历史账号 "${name}"`,
      );
      return { ...fallback, fallbackUsed: true };
    }
  }

  return null;
}

export function markCancelled(run: AutomationRun, persist: () => void) {
  run.status = "cancelled";
  const current = run.phases.find((phase) => phase.phase === run.currentPhase);
  if (current && current.status !== "completed") current.status = "failed";
  persist();
}

export function ensureBrowserHasBounds(browser: VbkBrowser): void {
  const view = (browser as unknown as { view?: { getBounds?: () => Electron.Rectangle | null } } | null | undefined)?.view;
  if (!view || typeof view.getBounds !== "function") return;
  const setBounds = (browser as unknown as { setBounds?: (b: { x: number; y: number; width: number; height: number }) => void } | null | undefined)?.setBounds;
  if (typeof setBounds !== "function") return;

  const wins = BrowserWindow.getAllWindows();
  const main = wins[0];
  if (!main) return;

  const [winWidth, winHeight] = main.getSize();
  if (winWidth <= 0 || winHeight <= 0) return;

  // 只在 renderer 还没上报过任何 bounds（当前是 0×0，首次跨进程触发）时
  // 才使用 fallback size。
  const current = view.getBounds();
  if (current && current.width > 0 && current.height > 0) {
    browser.setVisible?.(true);
    return;
  }

  // view 兑底尺寸：与 stage="vbk" 的 split 比例对齐（右 66%），
  // 不占满整窗口、避免盖住 React 顶栏 / 左边的阶段摘要。最小宽
  // 640 保证嵌入页面不被携程压成移动版布局。
  browser.setVisible?.(true);
  const fallbackWidth = Math.max(640, Math.round(winWidth * 0.66));
  setBounds!({
    x: winWidth - fallbackWidth,
    y: 0,
    width: fallbackWidth,
    height: winHeight,
  });
}
