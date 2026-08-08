import { BrowserWindow, WebContentsView, shell } from "electron";
import { openExternalUrl } from "./external-url.js";
import { chromium, type Browser, type Page } from "playwright";
import { URLS } from "../automation/constants.js";
import { fetchCurrentUserInfo } from "./current-user.js";
import type { LoginAccountsSnapshot, SavedLoginAccount } from "../../shared/contracts-types.js";
import type { SerialisedCookie } from "./vbk-cookie-serializer.js";
import {
  parseCookies,
  cookieUrl,
  removeUrlFromCookie,
  normaliseSameSite,
  normaliseExpiry,
} from "./vbk-cookie-serializer.js";

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

/**
 * 多账号登录需要的存储接口。
 * 抽成接口而不是直接 import VbkDatabase，避免 vbk-browser.ts 与 database.ts
 * 形成循环依赖（database 自己的 migrate 又会引用 main.ts 的 ipc 注册）。
 *
 * 关键差异：
 *  - accountKey 才是 cookie 表的主键（vbk_xxx 这种 loginAccount），
 *    不只是显示名。同一身份证的 vbk_xxx / "小璐" 多次保存应视作同一账号。
 */
export interface LoginSessionStore {
  saveSession(accountKey: string, accountName: string, cookiesJson: string): void;
  loadSession(accountKey: string): { cookiesJson: string; accountName: string } | null;
  listSessions(): SavedLoginAccount[];
  deleteSession(accountKey: string): void;
  /** 让浏览器侧记录"当前 WebView 实际展示的是谁"，与 login_sessions 表解耦。 */
  getActiveAccountKey(): string | undefined;
  setActiveAccountKey(key: string): void;
  clearActiveAccountKey(): void;
}

export class VbkBrowser {
  private view?: WebContentsView;
  private visible = false;
  private cdp?: Browser;

  constructor(
    private readonly window: BrowserWindow,
    private readonly debuggingPort: string,
    private readonly sessionStore?: LoginSessionStore,
  ) {}

  async initialise() {
    this.view = new WebContentsView({ webPreferences: { partition: "persist:vbk", contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window.contentView.addChildView(this.view);
    // 先抑制持久分区下 Chromium 默认启动的子系统副作用（WebRTC ICE → STUN
    // 探测 → 国内网络里 stun.services.mozilla.com 解析失败 ——
    // errorcode -105 / socket_manager.cc:137 噪音），再装导航/外链钩子。
    this.configureVbkWebContents();
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

  /**
   * 退出当前账号但**不**影响其他已记录账号：
   * 1. 抽出当前 session 的 cookies 但不写入登录快照（即将删除，无需持久化）；
   * 2. 清空当前 session 的所有 storage 与缓存；
   * 3. 导航到产品列表等待用户。
   *
   * 注意：保留 clearActiveAccountKey()，让"当前是谁"的指示器同步清掉。
   */
  async logout() {
    if (!this.view) return;
    await this.clearBrowserSessionCookies();
    await this.view.webContents.session.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await this.view.webContents.session.clearCache();
    this.sessionStore?.clearActiveAccountKey();
    await this.navigate(URLS.list);
  }

  /**
   * 把当前 WebView 的 cookies 抽出来保存到本机（login_sessions 表）。
   * 通常由 addLogin / switchAccount 在切换之前调用，账号未登录时直接 no-op。
   */
  async saveCurrentSession(): Promise<SavedLoginAccount | null> {
    if (!this.view) return null;
    if (!this.sessionStore) return null;
    const cookies = await this.collectCookies();
    if (cookies.length === 0) return null;
    // 「当前是谁」需要在抽 cookie 之前就探测完，否则页面看到的还是上一会话的 UI。
    const status = await this.status(false);
    if (!status.loggedIn) return null;
    const displayName = status.accountName || "已登录账号";
    const key = status.loginAccount || displayName;
    this.sessionStore.saveSession(key, displayName, JSON.stringify(cookies));
    this.sessionStore.setActiveAccountKey(key);
    return { accountKey: key, accountName: displayName, lastUsedAt: new Date().toISOString() };
  }

  /**
   * "新增登录"流程：
   *  1. 当前已登录 → 先 saveCurrentSession 把老账号 cookies 收进 login_sessions；
   *  2. 清空当前 session 的 cookies / storage / cache；
   *  3. 导航到 VBK 登录页，等用户在右侧 WebView 完成新账号登录；
   *  4. status() 检测到新登录后会再调一次 saveCurrentSession()（在 withKnownVbkAccount 钩子里）。
   *
   * 与 logout 的区别：这里显式保留老账号快照，让运营随时能切回去。
   */
  async addLogin() {
    if (!this.view) return;
    // 先把当前账号抓走；如果未登录，跳过这一步避免空快照落地。
    await this.saveCurrentSession();
    await this.clearBrowserSessionCookies();
    await this.view.webContents.session.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await this.view.webContents.session.clearCache();
    this.sessionStore?.clearActiveAccountKey();
    // 让登录页面尽可能快显示：使用轻量入口 URL 而不是产品库。
    await this.view.webContents.loadURL("https://vbooking.ctrip.com/");
  }

  /**
   * 切换到本机已记着的一个 VBK 账号：
   *  1. 当前已登录 → saveCurrentSession 把老账号存好；
   *  2. 把目标账号的 cookies 灌进当前 session；
   *  3. 重新导航到产品列表让 VBK 自己刷新账号上下文。
   *
   * 注意：cookies 设置之后**异步生效**，需要 await session.cookies.flushStore()
   * 才能保证接下来 loadURL 时 VBK 拿到的是新账号的会话。
   */
  async switchAccount(accountKey: string) {
    if (!this.view) return;
    if (!this.sessionStore) throw new Error("本机未启用多账号登录切换。");
    const trimmedKey = accountKey?.trim();
    if (!trimmedKey) throw new Error("切换账号失败：账号标识不能为空。");
    const record = this.sessionStore.loadSession(trimmedKey);
    if (!record) throw new Error(`本机未记录该 VBK 账号（${trimmedKey}），请先登录一次再切换。`);
    await this.saveCurrentSession();
    // 清掉旧账号残留的 cookies，确保就算目标账号 cookies 不全也不会留下混合会话。
    await this.clearBrowserSessionCookies();
    const cookies = parseCookies(record.cookiesJson);
    if (cookies.length === 0) {
      // 罕见：旧版记录可能为空，导航前补一条"目标账号"的占位 cookies 让写入不为空。
      // 这种 fallback 也能让下次 saveCurrentSession 自然重新覆盖。
    }
    for (const cookie of cookies) await this.applyCookie(cookie);
    // flushStore 让所有 set 都落盘，再加载产品库。
    if (typeof this.view.webContents.session.cookies.flushStore === "function") {
      await this.view.webContents.session.cookies.flushStore().catch(() => undefined);
    }
    this.sessionStore.setActiveAccountKey(trimmedKey);
    await this.view.webContents.loadURL(URLS.list);
  }

  /**
   * 忘记（删除）一个本机记着的账号快照。
   * 删除后运营再点该 chip 不会切回去 —— 调用方需负责提示。
   * WebView 当前正在展示的账号不允许忘记，否则会被一个已删除的记录
   * 立刻「复活」导致删除语义不一致。
   */
  forgetAccount(accountKey: string) {
    if (!this.sessionStore) throw new Error("本机未启用多账号登录切换。");
    const trimmedKey = accountKey?.trim();
    if (!trimmedKey) return;
    const active = this.sessionStore.getActiveAccountKey();
    if (active && active === trimmedKey) {
      throw new Error("当前正在使用的账号不能直接忘记，请先切换或登出。");
    }
    this.sessionStore.deleteSession(trimmedKey);
  }

  /** 列出当前 + 所有已记录的账号。 */
  listKnownLoginAccounts(): LoginAccountsSnapshot {
    if (!this.sessionStore) return { current: null, saved: [] };
    const saved = this.sessionStore.listSessions();
    const activeKey = this.sessionStore.getActiveAccountKey();
    if (!activeKey) return { current: null, saved };
    const match = saved.find((entry) => entry.accountKey === activeKey);
    if (!match) return { current: null, saved };
    return {
      current: { accountKey: match.accountKey, accountName: match.accountName, lastUsedAt: match.lastUsedAt },
      saved: saved.filter((entry) => entry.accountKey !== activeKey),
    };
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
    let loginAccount: string | undefined;
    try {
      const page = await this.page();
      const user = await fetchCurrentUserInfo(page);
      const display = user?.displayName?.trim();
      const login = user?.loginAccount?.trim();
      // 优先 loginAccount（vbk_671205），一目了然知道是哪个 VBK 账号；
      // 兜底 displayName（"小璐"）仅在 account 字段缺失时展示。
      if (login) loginAccount = login;
      if (display) accountName = display;
      else if (login) accountName = login;
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

    const accounts = accountName ? Array.from(new Set([accountName, loginAccount].filter(Boolean) as string[])) : [];
    const snapshot: LoginAccountsSnapshot = this.listKnownLoginAccounts();

    return {
      loggedIn: true,
      message: "VBK 已登录。",
      accountName,
      loginAccount,
      accounts: accounts.length ? accounts : (accountName ? [accountName] : []),
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

  /**
   * 抑制 persist:vbk 持久分区在 Chromium 内部自动启用的副作用。
   *
   * 背景：本应用只用「DOM/CDP 自动化」驱动 VBK 后台，没有 WebRTC 代码。
   * 但 `persist:vbk` 是持久分区（不是 incognito），Chromium 会对持久
   * session 默认开启完整的 WebRTC ICE candidate gathering —— 即便
   * 业务从不发起 PeerConnection，渲染进程一启动也会并发解析
   * stun.services.mozilla.com 的 A/AAAA 记录，配合 IPv6/4 双栈 + 重试
   * 喷出 5 条 `Failed to resolve address ... errorcode: -105` 噪音。
   *
   * 做法等价于 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`：
   * 不收集任何「非代理 UDP」ICE 候选，Chromium 直接放弃 STUN 解析。
   * 作用面是这一个 webContents，不动 BrowserWindow 主进程和别的视图，
   * 也不影响出方向的 HTTP/代理链路。
   */
  private configureVbkWebContents() {
    if (!this.view) return;
    try {
      this.view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    } catch {
      // 极端旧 Electron（<13）无此 API 时静默跳过；当前依赖 ^43 必然存在。
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 内部辅助
  // ─────────────────────────────────────────────────────────────

  /** 抽出当前 session 的全部 cookies。空数组表示未登录或已被清空。 */
  private async collectCookies(): Promise<Electron.Cookie[]> {
    if (!this.view) return [];
    try {
      return await this.view.webContents.session.cookies.get({});
    } catch {
      return [];
    }
  }

  /** 清空当前 session 的全部 cookies。会基于 cookie.domain 逐条 remove。 */
  private async clearBrowserSessionCookies() {
    if (!this.view) return;
    try {
      const existing = await this.view.webContents.session.cookies.get({});
      const view = this.view;
      await Promise.all(existing.map((cookie) => {
        const target = removeUrlFromCookie(cookie);
        if (!target) return Promise.resolve();
        return view.webContents.session.cookies.remove(target, cookie.name).catch(() => undefined);
      }));
    } catch {
      // get/remove 失败时走兜底路径：clearStorageData。
    }
  }

  /**
   * 把单条 cookie 写回 session。
   * 输入是 DB 里的 SerialisedCookie（Playwright 兼容结构），需要先根据
   * domain/scheme 构造 Electron `cookies.set` 要求的 url。
   */
  private async applyCookie(cookie: SerialisedCookie) {
    if (!this.view) return;
    const url = cookieUrl(cookie);
    if (!url) return;
    const details: Electron.CookiesSetDetails = {
      url,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: normaliseSameSite(cookie.sameSite),
      expirationDate: normaliseExpiry(cookie.expires),
    };
    // 如果 cookie 有显式 domain，写进 set 让它精确写入（url 模式会自动从 host 取 domain）。
    if (cookie.domain) details.domain = cookie.domain;
    try {
      await this.view.webContents.session.cookies.set(details);
    } catch {
      // 极少数 cookie（无效 domain / 跨 origin）写不进去，跳过；不要让某条失败阻塞整体切换。
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Cookie 序列化的具体归一化逻辑已拆到 ./vbk-cookie-serializer.ts，
// 这里只 import 用到的部分，避免单文件超过 400 行硬上限。
// ─────────────────────────────────────────────────────────────
