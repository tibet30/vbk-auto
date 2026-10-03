import { randomUUID } from "node:crypto";
import { BrowserWindow, type Session } from "electron";
import { type Browser, type Page } from "playwright";
import { attachVbkSessionFetch } from "./vbk-session-fetch-adapter.js";
import { navigateVbkPage } from "./vbk-navigation.js";
import { isAllowedVbkPageUrl } from "./vbk-page-selection.js";
import { isPinnedVbkNavigationAllowed, type VbkNavigationPin } from "./vbk-navigation-pin.js";
import { URLS } from "../automation/constants.js";

export interface AutomationSession {
  page: Page;
  window: BrowserWindow;
  pin: VbkNavigationPin | null;
  close: () => Promise<void>;
}

/** A hidden window has its own DOM/viewport but uses the exact captured account session. */
export async function createVbkAutomationSession(accountSession: Session, cdp: Browser): Promise<AutomationSession> {
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, skipTaskbar: true,
    webPreferences: { session: accountSession, focusOnNavigation: false, backgroundThrottling: false } });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (!window.isDestroyed()) window.destroy();
  };
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const bootstrap = new URL(URLS.list);
    bootstrap.searchParams.set("vbkAutomationWorker", randomUUID());
    await navigateVbkPage(window.webContents, bootstrap.toString());
    const page = cdp.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === bootstrap.toString());
    if (!page) throw new Error("未找到当前产品的独立 VBK 录入页面");
    attachVbkSessionFetch(page, accountSession);
    page.on("dialog", dialog => { void dialog.accept().catch(() => undefined); });
    const worker: AutomationSession = { page, window, pin: null, close };
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedVbkPageUrl(url) || !isPinnedVbkNavigationAllowed(url, worker.pin)) event.preventDefault();
    });
    return worker;
  } catch (error) { await close(); throw error; }
}
