import { BrowserWindow, WebContentsView, shell } from "electron";
import { openExternalUrl } from "./external-url.js";
import { chromium, type Browser, type Page } from "playwright";
import { URLS } from "../automation/constants.js";
import { fetchCurrentUserInfo } from "./current-user.js";

const allowedHosts = new Set(["vbooking.ctrip.com", "ctrip.com", "www.ctrip.com"]);

// DOM 抓取时丢弃的菜单/标签类文本：VBK 后台大量 class 名带 user / account
// 的导航项（如「账号管理」「用户管理」），会先于真实账号名命中旧 selector，
// 导致抓出"管理"两个字误显示。命中这里任一文本就视为假阳性。
const MENU_FALSE_POSITIVES = new Set([
  "管理", "管理员",
  "账号管理", "账号设置", "账号中心", "我的账号", "账号信息",
  "用户管理", "用户设置", "用户中心", "我的用户",
  "供应商管理", "登录", "退出登录", "退出",
  "新手指引", "帮助中心", "设置",
]);

export class VbkBrowser {
  private view?: WebContentsView;
  private visible = false;
  private cdp?: Browser;

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
  // 暴露当前嵌入式浏览器 URL：URL 栏需要实时反映页面跳转，否者用户点
  // 「进入」之后看到地址还是 /产品库，会误以为按钮没生效（实际上 VBK 内部
  // 可能又把页面重定向到 /产品库，地址栏同步过去才能区分「没跳转」和「跳转后被重定向」）。
  currentUrl(): string {
    return this.view?.webContents.getURL() || "";
  }
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
    if (!productListVisible) return { loggedIn: false, message: "尚未登录 VBK。" };

    // 1) 优先：通过 VBK getCurrentUserInfo 接口拿真实账号名。
    //    这是项目里已经实现的解析器（current-user.ts），能拿到 "张三" 这种
    //    真实可读名；旧的 DOM 抓取会把"账号管理"菜单误识别成"管理"。
    let accountName: string | undefined;
    try {
      const page = await this.page();
      const user = await fetchCurrentUserInfo(page);
      const display = user?.displayName?.trim();
      const login = user?.loginAccount?.trim();
      // 优先 loginAccount（vbk_671205），一目了然知道是哪个 VBK 账号；
      // 兜底 displayName（"小璐"）仅在 account 字段缺失时展示。
      if (login) accountName = login;
      else if (display) accountName = display;
    } catch {
      // API 失败（CDP 未就绪、接口变更、网络异常）→ fallback 到 DOM 抓取
    }

    // 2) Fallback：DOM 抓取 + 菜单白名单过滤。原先的 selector 太宽
    //    ([class*="user"] / [class*="account"]) 会把"账号管理"等菜单
    //    误识别成账号名，这里加黑名单丢掉。
    if (!accountName) {
      const scraped = await this.view.webContents.executeJavaScript(`
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
      `, true).catch(() => "");
      if (scraped && !MENU_FALSE_POSITIVES.has(scraped)) {
        accountName = scraped;
      }
    }

    return {
      loggedIn: true,
      message: "VBK 已登录。",
      accountName,
      accounts: accountName ? [accountName] : [],
    };
  }

  async page(): Promise<Page> {
    // 每次录入都新建一个 CDP 连接会持续累积 WebSocket，反复重试后拖垮自动化；
    // 这里复用同一个连接，断开后再重连。
    if (!this.cdp?.isConnected()) {
      this.cdp = await chromium.connectOverCDP(`http://127.0.0.1:${this.debuggingPort}`);
    }
    const pages = this.cdp.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url() === this.view?.webContents.getURL())
      ?? pages.find((candidate) => candidate.url().includes("ctrip.com"));
    if (!page) throw new Error("未找到嵌入式 VBK 页面，请先登录 VBK 后重试。");
    return page;
  }

  async dispose() {
    if (this.cdp?.isConnected()) await this.cdp.close().catch(() => {});
    this.cdp = undefined;
  }
}
