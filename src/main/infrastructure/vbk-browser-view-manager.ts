import { BrowserWindow, WebContentsView, session, shell } from "electron";
import type { Page } from "playwright";
import type { SerialisedCookie } from "./vbk-cookie-serializer.js";
import type { LoginSessionStore } from "./vbk-browser-types.js";
import type { VbkNavigationPin } from "./vbk-navigation-pin.js";
import { isPinnedVbkNavigationAllowed } from "./vbk-navigation-pin.js";
import { clearVbkViewStorage, collectVbkCookies, setVbkCookieOn } from "./vbk-browser-cookies.js";
import { createVbkRequestPage } from "./vbk-request-page.js";
import { fetchCurrentUserInfo } from "./current-user.js";

const allowedHosts = new Set(["vbooking.ctrip.com", "ctrip.com", "www.ctrip.com"]);

export class VbkBrowserViewManager {
  readonly accounts = new Map<string, WebContentsView>();
  activeKey?: string;
  defaultView?: WebContentsView;
  visible = false;
  bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private navigationPin: VbkNavigationPin | null = null;
  private cachedUserInfoUrl?: string;
  private cachedUserInfoWebContentsId?: number;
  private cachedUserInfo?: { displayName?: string; loginAccount?: string };

  constructor(
    readonly window: BrowserWindow,
    readonly sessionStore: LoginSessionStore | undefined,
    private readonly interactivePage: () => Promise<Page>,
    private readonly onVisibleBlank: () => void,
  ) {}

  get view(): WebContentsView | undefined {
    return this.activeKey ? this.accounts.get(this.activeKey) : this.defaultView;
  }

  getPartition(accountKey: string): string {
    return `persist:account_${accountKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }

  createView(partition: string): WebContentsView {
    const view = new WebContentsView({ webPreferences: { partition, focusOnNavigation: false } });
    try { view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); } catch { /* old Electron */ }
    this.installNavigationHooks(view);
    return view;
  }

  ensureDefaultView(): WebContentsView {
    if (!this.defaultView) this.defaultView = this.createView("persist:vbk");
    return this.defaultView;
  }

  async ensureAccountView(accountKey: string, cookies: SerialisedCookie[]): Promise<WebContentsView> {
    let view = this.accounts.get(accountKey);
    if (view) await this.clearViewStorage(view);
    else {
      view = this.createView(this.getPartition(accountKey));
      this.accounts.set(accountKey, view);
    }
    if (!view.webContents.getURL()) await view.webContents.loadURL("about:blank");
    for (const cookie of cookies) await setVbkCookieOn(view, cookie);
    if (cookies.length) await view.webContents.session.cookies.flushStore().catch(() => undefined);
    return view;
  }

  activateView(view: WebContentsView, accountKey?: string): void {
    const current = this.view;
    const nextKey = accountKey || undefined;
    if (current !== view || this.activeKey !== nextKey) this.clearCachedUserInfo();
    if (current && current !== view) {
      current.setVisible(false);
      this.window.contentView.removeChildView(current);
    }
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(this.visible);
    this.activeKey = nextKey;
    if (accountKey) this.sessionStore?.setActiveAccountKey(accountKey);
  }

  setBounds(bounds: Electron.Rectangle): void {
    this.bounds = bounds;
    this.view?.setBounds(bounds);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.view?.setVisible(visible);
    if (visible && this.view && /^(?:about:blank)?$/.test(this.view.webContents.getURL())) this.onVisibleBlank();
  }

  currentUrl(): string { return this.view?.webContents.getURL() || ""; }

  evaluateInView<T, A = unknown>(view: WebContentsView, fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
    return view.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`) as Promise<T>;
  }

  fetchCurrentUserInfoInView(view: WebContentsView) {
    return fetchCurrentUserInfo(createVbkRequestPage({
      session: view.webContents.session,
      assertActive: () => { if (view.webContents.isDestroyed()) throw new Error("VBK 账号会话已关闭"); },
      currentUrl: () => view.webContents.getURL(),
      interactivePage: this.interactivePage,
    }));
  }

  cachedUser(url: string, webContentsId: number) {
    return url === this.cachedUserInfoUrl && webContentsId === this.cachedUserInfoWebContentsId
      ? this.cachedUserInfo
      : undefined;
  }

  cacheUser(url: string, webContentsId: number, value: { displayName?: string; loginAccount?: string }): void {
    this.cachedUserInfoUrl = url;
    this.cachedUserInfoWebContentsId = webContentsId;
    this.cachedUserInfo = value;
  }

  clearCachedUserInfo(): void {
    this.cachedUserInfoUrl = undefined;
    this.cachedUserInfoWebContentsId = undefined;
    this.cachedUserInfo = undefined;
  }

  pinProductNavigation(pin: VbkNavigationPin): void {
    this.navigationPin = { allowCreateSetup: pin.allowCreateSetup, allowedProductIds: [...pin.allowedProductIds] };
  }

  addPinnedProductId(productId: string): void {
    const id = productId.trim();
    if (id && this.navigationPin && !this.navigationPin.allowedProductIds.includes(id)) {
      this.navigationPin.allowedProductIds.push(id);
    }
  }

  clearNavigationPin(): void { this.navigationPin = null; }

  async clearViewStorage(view: WebContentsView): Promise<void> {
    this.clearCachedUserInfo();
    await clearVbkViewStorage(view);
    this.clearCachedUserInfo();
  }

  collectCookies(view = this.view): Promise<Electron.Cookie[]> { return collectVbkCookies(view); }

  forgetPartition(accountKey: string): void {
    const ses = session.fromPartition(this.getPartition(accountKey));
    void ses.clearStorageData().catch(() => undefined);
    void ses.clearCache().catch(() => undefined);
    const view = this.accounts.get(accountKey);
    if (view) {
      try { view.webContents.close(); } catch { /* already closed */ }
      this.accounts.delete(accountKey);
    }
  }

  dispose(): void {
    for (const view of this.accounts.values()) {
      try { view.webContents.close(); } catch { /* already closed */ }
    }
    this.accounts.clear();
    if (this.defaultView) {
      try { this.defaultView.webContents.close(); } catch { /* already closed */ }
      this.defaultView = undefined;
    }
  }

  private installNavigationHooks(view: WebContentsView): void {
    view.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
    view.webContents.on("did-start-navigation", () => this.clearCachedUserInfo());
    view.webContents.on("did-navigate-in-page", () => this.clearCachedUserInfo());
    view.webContents.on("will-navigate", (event, url) => {
      const host = new URL(url).hostname;
      if (![...allowedHosts].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        event.preventDefault();
        void shell.openExternal(url);
      } else if (!isPinnedVbkNavigationAllowed(url, this.navigationPin)) event.preventDefault();
    });
  }
}
