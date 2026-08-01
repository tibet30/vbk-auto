import { BrowserWindow, WebContentsView, shell } from "electron";
import { openExternalUrl } from "./external-url.js";
import { chromium, type Page } from "playwright";
import { URLS } from "./automation/constants.js";

const allowedHosts = new Set(["vbooking.ctrip.com", "ctrip.com", "www.ctrip.com"]);

export class VbkBrowser {
  private view?: WebContentsView;
  private visible = false;

  constructor(private readonly window: BrowserWindow, private readonly debuggingPort: string) {}

  async initialise() {
    this.view = new WebContentsView({ webPreferences: { partition: "persist:vbk", contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window.contentView.addChildView(this.view);
    this.view.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
    this.view.webContents.on("will-navigate", (event, url) => {
      const host = new URL(url).hostname;
      if (![...allowedHosts].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        event.preventDefault(); void shell.openExternal(url);
      }
    });
    await this.view.webContents.loadURL(URLS.list);
    this.setVisible(false);
  }

  setBounds(bounds: Electron.Rectangle) { this.view?.setBounds(bounds); }
  setVisible(visible: boolean) { this.visible = visible; this.view?.setVisible(visible); }
  async openExternal() {
    const url = this.view?.webContents.getURL() || "";
    await openExternalUrl(url, (value) => shell.openExternal(value));
  }
  async navigate(url: string) {
    const host = new URL(url).hostname;
    if (![...allowedHosts].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) throw new Error("仅允许在内置 VBK 浏览器中打开携程页面");
    await this.view?.webContents.loadURL(url);
  }
  async login() { this.setVisible(true); await this.navigate(URLS.list); }
  async logout() {
    if (!this.view) return;
    await this.view.webContents.session.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await this.view.webContents.session.clearCache();
    await this.navigate(URLS.list);
  }

  async status(refresh = false) {
    if (!this.view) return { loggedIn: false, message: "VBK 浏览器尚未准备好。" };
    if (refresh) await this.navigate(URLS.list);
    const url = this.view.webContents.getURL();
    if (/login|passport/i.test(url)) return { loggedIn: false, message: "尚未登录 VBK。" };
    const productListVisible = await this.view.webContents.executeJavaScript(`
      document.body?.innerText?.includes("产品列表") === true
    `, true).catch(() => false);
    const accountName = productListVisible ? await this.view.webContents.executeJavaScript(`
      (() => {
        const selectors = [
          '[class*="user"]', '[class*="account"]', '[class*="avatar"]',
          '[class*="profile"]', '.user-name', '.account-name'
        ];
        const candidates = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .map((node) => node.textContent?.trim())
          .filter(Boolean)
          .filter((text) => text.length >= 2 && text.length <= 32);
        const body = document.body?.innerText || "";
        const bodyMatch = body.match(/(?:供应商|账号|用户|登录人)[:：\\s]*([^\\n\\s]{2,24})/);
        return candidates[0] || bodyMatch?.[1] || "";
      })()
    `, true).catch(() => "") : "";
    return productListVisible
      ? { loggedIn: true, message: "VBK 已登录。", accountName: accountName || undefined, accounts: accountName ? [accountName] : [] }
      : { loggedIn: false, message: "尚未登录 VBK。" };
  }

  async page(): Promise<Page> {
    const endpoint = `http://127.0.0.1:${this.debuggingPort}`;
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() === this.view?.webContents.getURL())
      ?? browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("ctrip.com"));
    if (!page) throw new Error("未找到嵌入式 VBK 页面，请先登录 VBK 后重试。");
    return page;
  }
}
