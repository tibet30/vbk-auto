/** Embedded VBK browser facade. View, account and Playwright concerns live in focused modules. */
import { shell, type BrowserWindow } from "electron";
import type { Page } from "playwright";
import { logWarn } from "../../shared/log-timestamp.js";
import { URLS } from "../automation/constants.js";
import { openExternalUrl } from "./external-url.js";
import { navigateVbkPage, isExpectedLoginRedirect } from "./vbk-navigation.js";
import { parseCookies } from "./vbk-cookie-serializer.js";
import { isVbkAuthCookieSummaryComplete, summarizeVbkAuthCookies } from "./vbk-auth-cookies.js";
import type { VbkNavigationPin } from "./vbk-navigation-pin.js";
import type { VbkSessionNativeRequest } from "./vbk-session-request.js";
import { VbkBrowserViewManager } from "./vbk-browser-view-manager.js";
import { VbkBrowserAccounts } from "./vbk-browser-accounts.js";
import { VbkBrowserPageDriver } from "./vbk-browser-page-driver.js";
import type { LoginSessionRecord, LoginSessionStore } from "./vbk-browser-types.js";

export type { LoginSessionStore } from "./vbk-browser-types.js";

export class VbkBrowser {
  readonly nativeOnly = true;
  private initialisePromise?: Promise<void>;
  private initialiseState: "idle" | "initialising" | "ready" | "failed" = "idle";
  private initialiseError?: string;
  private readonly initialPageLoads = new Map<number, Promise<void>>();
  private readonly views: VbkBrowserViewManager;
  private readonly accountService: VbkBrowserAccounts;
  private readonly pageDriver: VbkBrowserPageDriver;

  constructor(window: BrowserWindow, debuggingPort: string, sessionStore?: LoginSessionStore) {
    this.views = new VbkBrowserViewManager(
      window,
      sessionStore,
      () => this.page({ requireInteractive: true }),
      () => { void this.ensureInitialPage().catch((error) => logWarn("[vbk] visible page load failed", error)); },
    );
    this.pageDriver = new VbkBrowserPageDriver(
      this.views,
      debuggingPort,
      () => this.ensureReadyForAction(),
      () => this.ensureInitialPage(),
    );
    this.accountService = new VbkBrowserAccounts(
      this.views,
      sessionStore,
      () => this.ensureReadyForAction(),
      () => this.pageDriver.stopItineraryDraftCapture(),
      () => this.ensureInitialPage(),
    );
  }

  initialise(): Promise<void> {
    if (this.initialisePromise) return this.initialisePromise;
    this.initialiseState = "initialising";
    this.initialiseError = undefined;
    const pending = this.initialiseOnce().then(() => {
      this.initialiseState = "ready";
    }).catch((error) => {
      this.initialiseState = "failed";
      this.initialiseError = error instanceof Error ? error.message : "VBK 页面加载失败。";
      throw error;
    });
    this.initialisePromise = pending;
    return pending;
  }

  private async initialiseOnce(): Promise<void> {
    const store = this.views.sessionStore;
    const activeKey = store?.getActiveAccountKey();
    const record: LoginSessionRecord = activeKey ? store?.loadSession(activeKey) ?? null : null;
    const cookies = record ? parseCookies(record.cookiesJson) : [];
    const authSummary = summarizeVbkAuthCookies(cookies);
    if (activeKey && cookies.length > 0 && isVbkAuthCookieSummaryComplete(authSummary)) {
      const view = await this.views.ensureAccountView(activeKey, cookies);
      this.views.activateView(view, activeKey);
    } else {
      const view = this.views.ensureDefaultView();
      this.views.activateView(view);
      await view.webContents.loadURL(URLS.list);
    }
    this.setVisible(false);
  }

  private async ensureReadyForAction(): Promise<void> {
    if (this.initialiseState === "ready") return;
    if (this.initialiseState === "failed") this.initialisePromise = undefined;
    await this.initialise();
  }

  setBounds(bounds: Electron.Rectangle): void { this.views.setBounds(bounds); }
  setVisible(visible: boolean): void { this.views.setVisible(visible); }
  isVisible(): boolean { return this.views.visible; }
  currentUrl(): string { return this.views.currentUrl(); }

  async evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
    await this.ensureReadyForAction();
    const view = this.views.view;
    if (!view) throw new Error("VBK 浏览器尚未初始化");
    return this.views.evaluateInView(view, fn, arg);
  }

  async openExternal(): Promise<void> {
    await openExternalUrl(this.currentUrl(), (value) => shell.openExternal(value));
  }

  async navigate(url: string): Promise<void> {
    await this.ensureReadyForAction();
    await navigateVbkPage(this.views.view?.webContents, url);
  }

  private async ensureInitialPage(): Promise<void> {
    const contents = this.views.view?.webContents;
    if (!contents) throw new Error("VBK 浏览器尚未初始化");
    const pending = this.initialPageLoads.get(contents.id);
    if (pending) return pending;
    if (!/^(?:about:blank)?$/.test(contents.getURL())) return;
    const task = navigateVbkPage(contents, URLS.list, { allowRedirect: isExpectedLoginRedirect });
    this.initialPageLoads.set(contents.id, task);
    try { await task; } finally { this.initialPageLoads.delete(contents.id); }
  }

  async login(): Promise<void> {
    await this.ensureReadyForAction();
    this.views.visible = true;
    this.views.view?.setVisible(true);
    await navigateVbkPage(this.views.view?.webContents, URLS.list, { allowRedirect: isExpectedLoginRedirect });
  }

  logout(): Promise<void> { return this.accountService.logout(); }
  saveCurrentSession() { return this.accountService.saveCurrentSession(); }
  addLogin(): Promise<void> { return this.accountService.addLogin(); }
  switchAccount(accountKey: string): Promise<void> { return this.accountService.switchAccount(accountKey); }
  forgetAccount(accountKey: string): void { this.accountService.forgetAccount(accountKey); }
  listKnownLoginAccounts() { return this.accountService.listKnownLoginAccounts(); }

  async status(refresh = false) {
    return this.accountService.status(async (shouldRefresh) => {
      if (this.initialiseState !== "ready") {
        if (shouldRefresh) {
          try {
            if (this.initialiseState === "failed") this.initialisePromise = undefined;
            await this.initialise();
          } catch {
            return { ready: false, message: this.initialiseError || "VBK 页面加载失败，请重试。" };
          }
        } else {
          return {
            ready: false,
            message: this.initialiseState === "failed"
              ? this.initialiseError || "VBK 页面加载失败，请重试。"
              : "VBK 浏览器正在准备中。",
          };
        }
      }
      return { ready: true };
    }, refresh);
  }

  requestPage(): Promise<Page> { return this.pageDriver.requestPage(); }
  vbkSessionFetch(request: VbkSessionNativeRequest) { return this.pageDriver.vbkSessionFetch(request); }
  page(options: { requireInteractive?: boolean } = {}): Promise<Page> { return this.pageDriver.page(options); }
  armItineraryDraftCapture(productId: string) { return this.pageDriver.armItineraryDraftCapture(productId); }
  readItineraryDraftCapture() { return this.pageDriver.readItineraryDraftCapture(); }
  stopItineraryDraftCapture(): void { this.pageDriver.stopItineraryDraftCapture(); }

  async dispose(): Promise<void> {
    await this.pageDriver.dispose();
    this.views.dispose();
  }

  async waitUntilReady(): Promise<boolean> { return (await this.status(true)).loggedIn; }
  pinProductNavigation(pin: VbkNavigationPin): void { this.views.pinProductNavigation(pin); }
  addPinnedProductId(productId: string): void { this.views.addPinnedProductId(productId); }
  clearNavigationPin(): void { this.views.clearNavigationPin(); }
}
