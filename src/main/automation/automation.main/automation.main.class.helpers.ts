/**
 * AutomationRun 编排用到的几个跨阶段 helper：
 *   - resolveButlerSelection / resolveProductButlerSelection / resolveServicePhone：拆出管家联系人和 400 电话；
 *   - resolveActiveButlerContext：当前账号没配好时回退到 listKnownAccounts 中任意一个；
 *   - markCancelled：把运行中的 run 切到 cancelled；
 *   - ensureBrowserHasBounds：view 未上报 bounds 时，把 splitter 区域调到主窗口的右 66%。
 */

import { createRequire } from "node:module";
import type { AutomationRun, ContactCardSelection } from "../../../shared/contracts.js";
import type { ActiveButlerContext } from "./automation.main.context.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";
import { logWarn } from "../../../shared/log-timestamp.js";
import { newSupplierProductCode } from "../../infrastructure/database/parts/types.js";

const electronRequire = createRequire(import.meta.url);

interface ElectronBrowserWindow {
  getAllWindows: () => Array<{ getSize: () => [number, number] }>;
}

function resolveElectronBrowserWindow(): ElectronBrowserWindow | null {
  try {
    const electron = electronRequire("electron") as { BrowserWindow?: ElectronBrowserWindow };
    return electron.BrowserWindow ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 db.getAccountFixedInfo(accountName).values.butlerName 解析出管家联系卡选择；
 * 缺账号 / 缺失管家 → 返回 null。
 */
export function resolveButlerSelection(db: VbkDatabase, accountName: string | undefined): ContactCardSelection | null {
  if (!accountName) return null;
  const info = db.getAccountFixedInfo(accountName);
  const butler = info.values.butlerName;
  return butler && typeof butler === "object" ? butler : null;
}

function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const contactCardId = candidate.contactCardId;
  const providerId = candidate.providerId;
  const displayName = candidate.displayName;
  return Number.isInteger(contactCardId)
    && Number(contactCardId) > 0
    && Number.isInteger(providerId)
    && Number(providerId) > 0
    && typeof displayName === "string"
    && displayName.trim().length > 0;
}

/**
 * 从 product.operations.bookingControls.butler 读取基础信息阶段实际要填的管家联系人。
 * 创建路径会把账号固定信息固化到 product JSON；自动化阶段只读 product，避免账号
 * 后续改动覆盖已创建产品的负责人。
 */
export function resolveProductButlerSelection(product: Record<string, unknown>): ContactCardSelection | null {
  const operations = product.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return null;
  const bookingControls = (operations as Record<string, unknown>).bookingControls;
  if (!bookingControls || typeof bookingControls !== "object" || Array.isArray(bookingControls)) return null;
  const butler = (bookingControls as Record<string, unknown>).butler;
  if (!isContactCardSelection(butler)) return null;
  return {
    contactCardId: butler.contactCardId,
    providerId: butler.providerId,
    displayName: butler.displayName.trim(),
  };
}

/**
 * 兼容旧产品：早期供应商产品编号为「VBK-联系人名字」，同一管家会重复。
 * 录入 basic 前若发现这个精确旧格式，就升级为当前规则「VBK-联系人名字-时间」。
 * 手工维护过的编号、已带时间戳的编号都不改。
 */
export function ensureLegacySupplierProductCodeUpgraded(
  product: Record<string, unknown>,
  butlerSelection: ContactCardSelection | null,
): string | null {
  if (!butlerSelection) return null;
  const basicInfo = product.basicInfo;
  if (!basicInfo || typeof basicInfo !== "object" || Array.isArray(basicInfo)) return null;
  const basic = basicInfo as Record<string, unknown>;
  const current = typeof basic.supplierProductCode === "string" ? basic.supplierProductCode.trim() : "";
  const contactName = butlerSelection.displayName.trim();
  if (!contactName || current !== `VBK-${contactName}`) return null;
  const next = newSupplierProductCode(contactName);
  basic.supplierProductCode = next;
  return next;
}

/**
 * 从 db.getAccountFixedInfo(accountName).values.servicePhone 取 trim 后非空电话；
 * 缺账号 / 缺失电话 → 返回 null。
 */
export function resolveServicePhone(db: VbkDatabase, accountName: string | undefined): string | null {
  if (!accountName) return null;
  const info = db.getAccountFixedInfo(accountName);
  const phone = info.values.servicePhone;
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  return trimmed || null;
}

export interface ActiveServicePhoneContext {
  accountName: string;
  servicePhone: string;
  fallbackUsed: boolean;
}

/**
 * 解析当前可用的 400 电话上下文。basic 阶段的管家联系人已经固化在 product JSON，
 * 这里不再要求账号固定信息里仍保留 butlerName。
 */
export function resolveActiveServicePhoneContext(
  db: VbkDatabase,
  accountName?: string,
): ActiveServicePhoneContext | null {
  const isReady = (name: string) => {
    const servicePhone = resolveServicePhone(db, name);
    if (!servicePhone) return null;
    return { accountName: name, servicePhone, fallbackUsed: false };
  };

  const activeAccountKey = db.getSetting("vbkActiveAccountKey")?.value?.trim() || "";
  const directCandidates = [...new Set([activeAccountKey, accountName?.trim() || ""].filter(Boolean))];
  for (const candidate of directCandidates) {
    const direct = isReady(candidate);
    if (direct) return direct;
  }

  const known = db.listKnownAccounts().map((item) => item.accountName);
  for (const name of known) {
    if (directCandidates.includes(name)) continue;
    const fallback = isReady(name);
    if (fallback) {
      logWarn(
        `[automation] 当前 vbkAccountName "${accountName || "<空>"}" 未匹配到有效 400 电话，回退到历史账号 "${name}"`,
      );
      return { ...fallback, fallbackUsed: true };
    }
  }

  return null;
}

/**
 * 解析当前可用的管家上下文：
 *   - 优先尝试当前 accountName；不行时遍历 listKnownAccounts 找任何能拼齐
 *     管家 + 400 电话的账号；回退成功时把 fallbackUsed=true 让上层写回 vbkAccountName；
 *   - 完全找不到返回 null，让上层抛阻断错。
 */
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
      logWarn(
        `[automation] 当前 vbkAccountName "${accountName || "<空>"}" 未匹配到有效固定信息，回退到历史账号 "${name}"`,
      );
      return { ...fallback, fallbackUsed: true };
    }
  }

  return null;
}

/**
 * 把 run 切成 cancelled，并把当前阶段（若未完成）标 failed；调 persist 同步到 DB。
 */
export function markCancelled(run: AutomationRun, persist: () => void) {
  run.status = "cancelled";
  const current = run.phases.find((phase) => phase.phase === run.currentPhase);
  if (current && current.status !== "completed") current.status = "failed";
  persist();
}

/**
 * 让 VBK 内嵌视图（Electron BrowserView / WebContentsView）拿到非零 bounds：
 *   - 若 view 已经上报过非零 width/height，仅 setVisible(true) 即可；
 *   - 否则用 BrowserWindow 主窗口 size 推算：右 66%，最低宽 640，
 *     让 VBK 不会被压成移动版布局。
 * 仅 Electron 内运行；其它环境（单测 / 非 Electron 调试）安静退出。
 */
export function ensureBrowserHasBounds(browser: VbkBrowser): void {
  const view = (browser as unknown as { view?: { getBounds?: () => { width: number; height: number } | null } } | null | undefined)?.view;
  if (!view || typeof view.getBounds !== "function") return;
  // 不能把 browser.setBounds 提取到局部变量再以普通函数形式调用：
  // VbkBrowser.setBounds 内部依赖 `this._bounds = bounds`，被解构后
  // this 在严格模式下会变 undefined，进而抛 "Cannot set properties of
  // undefined (setting '_bounds')"。这里直接用属性访问，确保 this 绑
  // 定到 browser 实例。
  if (typeof browser.setBounds !== "function") return;

  const BrowserWindow = resolveElectronBrowserWindow();
  if (!BrowserWindow) return;

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
  browser.setBounds({
    x: winWidth - fallbackWidth,
    y: 0,
    width: fallbackWidth,
    height: winHeight,
  });
}
