/**
 * 嵌入式 VBK 浏览器（VbkBrowser）+ 多账号登录支持：
 *   - 每个账号使用独立的 Electron partition（persist:account_<key>），
 *     cookie / localStorage / 缓存由系统自动隔离，不再手动搬运；
 *   - initialise 创建默认视图（persist:vbk）用于首次登录 / 新增登录，
 *     同时恢复上次活跃账号的 partition 视图；
 *   - switchAccount 直接切换视图，仅在首次创建时从 sessionStore 一次性迁移；
 *   - addLogin 清空默认视图、跳转登录页；登录后自动创建 partition 视图并迁移；
 *   - forgetAccount 清除 partition 存储 + 销毁视图 + 删除 sessionStore 记录；
 *   - saveCurrentSession 写入 sessionStore（0600 JSON 文件），并 await 其结果；
 *     写入失败 → 返回 null（不抛错），由 IPC / UI 边界决定如何提示用户。
 *
 * Cookie 持久化历史说明：
 *   - 早期版本通过 SQLite login_sessions 表 + Electron Keychain 加密；
 *   - 用户决策后 AI API keys 与 VBK cookies 一律改走本地 0600 JSON 文件，
 *     完全脱离 Keychain 加密层。本文件不再导入任何 `electron` 加密 API，
 *     也未再读取 SQLite 里的 cookies_ciphertext / cookies_json。
 */

import { BrowserWindow, WebContentsView, session, shell } from "electron";
import { openExternalUrl } from "./external-url.js";
import { chromium, type Browser, type Page } from "playwright";
import { URLS } from "../automation/constants.js";
import { fetchCurrentUserInfo } from "./current-user.js";
import { selectVbkPage } from "./vbk-page-selection.js";
import type { LoginAccountsSnapshot, SavedLoginAccount } from "../../shared/contracts-types.js";
import type { SerialisedCookie } from "./vbk-cookie-serializer.js";
import {
  parseCookies,
  cookieUrl,
  removeUrlFromCookie,
  normaliseSameSite,
  normaliseExpiry,
} from "./vbk-cookie-serializer.js";
import { waitForDomText } from "./vbk-page-wait.js";
import { navigateVbkPage } from "./vbk-navigation.js";
import {
  VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE,
  isVbkAuthCookieSummaryComplete,
  summarizeVbkAuthCookies,
} from "./vbk-auth-cookies.js";

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
  /**
   * cookies **明文** JSON 字符串。Store 内部必须负责落盘（0600 JSON 文件，
   * 严禁写入 SQLite）。返回 Promise<void> 即可；调用方会 await 并捕获错误。
   * 空数组 / 空字符串 / 当前账号未登录时调用方不会调用本方法；
   * store 内部对"空快照 = 删除"语义自行处理。
   */
  saveSession(accountKey: string, accountName: string, cookiesJson: string): void | Promise<void>;
  /**
   * 返回 **明文** cookies JSON 字符串。找不到时返回 null。
   */
  loadSession(accountKey: string): { cookiesJson: string; accountName: string } | null;
  listSessions(): SavedLoginAccount[];
  deleteSession(accountKey: string): void;
  /** 让浏览器侧记录"当前 WebView 实际展示的是谁"，与 cookie-store 解耦。 */
  getActiveAccountKey(): string | undefined;
  setActiveAccountKey(key: string): void;
  clearActiveAccountKey(): void;
}

type LoginSessionRecord = ReturnType<LoginSessionStore["loadSession"]>;

export class VbkBrowser {
  // ── 多分区 view 管理 ──
  /** 按 accountKey 索引的 partition 视图；每个账号一个独立 partition。 */
  private accounts: Map<string, WebContentsView> = new Map();
  /** 当前活跃的账号 key。undefined = 使用默认视图（persist:vbk）。 */
  private activeKey?: string;
  /** 默认视图：用于首次登录 / 新增登录，partition = persist:vbk。 */
  private defaultView?: WebContentsView;
  /** 视图可见性标记（用于 setVisible 状态同步）。 */
  private visible = false;
  /** 缓存的 bounds，用于切换视图时恢复布局。 */
  private _bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  /** CDP 连接（Playwright 驱动自动化用），跨 partition 共用。 */
  private cdp?: Browser;
  /** fetchCurrentUserInfo 结果缓存：同一 URL 下避免重复 HTTP。login/logout 时清除。 */
  private cachedUserInfoUrl?: string;
  private cachedUserInfo?: { displayName?: string; loginAccount?: string };

  constructor(
    private readonly window: BrowserWindow,
    private readonly debuggingPort: string,
    private readonly sessionStore?: LoginSessionStore,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // 视图访问器（向后兼容：所有内部/外部代码仍可通过 this.view 访问当前视图）
  // ─────────────────────────────────────────────────────────────

  /** 当前活跃的 WebContentsView；未登录/默认状态返回 defaultView。 */
  private get view(): WebContentsView | undefined {
    if (this.activeKey) return this.accounts.get(this.activeKey);
    return this.defaultView;
  }

  // ─────────────────────────────────────────────────────────────
  // Partition 与视图工厂
  // ─────────────────────────────────────────────────────────────

  /** 根据账号 key 生成 partition 名（persist:account_<sanitized_key>）。 */
  private getPartition(accountKey: string): string {
    const safe = accountKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `persist:account_${safe}`;
  }

  /** 创建一个已配置 RTC 抑制 + 导航白名单 + 外链钩子的 WebContentsView。 */
  private createView(partition: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { partition },
    });
    this.configureRtc(view);
    this.installNavigationHooks(view);
    return view;
  }

  /** 获取或创建指定账号的 partition 视图。首次创建时写入调用方已读取的 cookie 快照。 */
  private async ensureAccountView(accountKey: string, cookies: SerialisedCookie[]): Promise<WebContentsView> {
    let view = this.accounts.get(accountKey);
    if (view) return view;

    view = this.createView(this.getPartition(accountKey));
    this.accounts.set(accountKey, view);

    // 首次创建：迁移调用方已经验证过的 cookie 快照（后续 Electron 自动持久化）。
    if (cookies.length > 0) {
      for (const cookie of cookies) {
        await this.setCookieOn(view, cookie);
      }
      await view.webContents.session.cookies.flushStore().catch(() => undefined);
    }
    return view;
  }

  // ─────────────────────────────────────────────────────────────
  // 视图切换
  // ─────────────────────────────────────────────────────────────

  /** 把窗口内容切换到指定视图。负责 detach 旧视图 + attach 新视图 + 同步状态。 */
  private activateView(view: WebContentsView, accountKey?: string) {
    const current = this.view;
    if (current && current !== view) {
      current.setVisible(false);
      this.window.contentView.removeChildView(current);
    }
    this.window.contentView.addChildView(view);
    view.setBounds(this._bounds);
    view.setVisible(this.visible);

    this.activeKey = accountKey || undefined;
    if (accountKey) {
      this.sessionStore?.setActiveAccountKey(accountKey);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────────

  /**
   * 初始化嵌入式浏览器：
   *   - 创建默认视图（persist:vbk），用于首次登录 / 新增登录；
   *   - 若存在上次活跃账号，同步创建其 partition 视图并恢复 cookies；
   *   - 默认隐藏，待 login() / setVisible(true) 才显示。
   */
  async initialise() {
    // 默认视图：始终存在，供 addLogin / 初始登录使用
    this.defaultView = this.createView("persist:vbk");
    this.window.contentView.addChildView(this.defaultView);
    await this.defaultView.webContents.loadURL(URLS.list);

    // 恢复上次活跃账号的 partition 视图
    const activeKey = this.sessionStore?.getActiveAccountKey();
    const record: LoginSessionRecord = activeKey ? this.sessionStore?.loadSession(activeKey) ?? null : null;
    const cookies = record ? parseCookies(record.cookiesJson) : [];
    const authSummary = summarizeVbkAuthCookies(cookies);
    // 活跃账号指针只是上次展示状态，不代表 account partition 已有登录态。
    // 没有可恢复的 DB 快照时必须继续使用 persist:vbk，避免空分区覆盖仍可用的默认登录态。
    if (activeKey && cookies.length > 0 && isVbkAuthCookieSummaryComplete(authSummary)) {
      const view = await this.ensureAccountView(activeKey, cookies);
      // 进程重启后 WebContents 初始 URL 可能是空白页。即使 partition 中
      // 已有登录 cookie，也必须先把该账号 view 导航到 VBK 列表，避免 CDP
      // 将 Electron renderer / 空白页误作为当前会话页面。
      await view.webContents.loadURL(URLS.list);
      // 复用统一切换路径：必须先 detach 默认 view，避免重启恢复后两个
      // WebContentsView 同时挂在窗口上，造成可见性和布局归属不确定。
      this.activateView(view, activeKey);
    }

    this.setVisible(false);
  }

  /**
   * 调整 view 布局（Electron.Rectangle）；同时缓存 bounds 用于后续视图切换。
   */
  setBounds(bounds: Electron.Rectangle) {
    this._bounds = bounds;
    this.view?.setBounds(bounds);
  }

  /** 设置 view 可见性；同时维护 this.visible 状态供外部读取。 */
  setVisible(visible: boolean) {
    this.visible = visible;
    this.view?.setVisible(visible);
  }

  // 暴露当前嵌入式浏览器 URL：URL 栏需要实时反映页面跳转，否者用户点
  // 「进入」之后看到地址还是 /产品库，会误以为按钮没生效（实际上 VBK 内部
  // 可能又把页面重定向到 /产品库，地址栏同步过去才能区分「没跳转」和「跳转后被重定向」）。
  currentUrl(): string {
    return this.view?.webContents.getURL() || "";
  }

  /** 在当前已登录 WebView 页面上下文执行只读函数；不暴露或持久化 cookie。 */
  async evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
    if (!this.view) throw new Error("VBK 浏览器尚未初始化");
    return this.view.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`) as Promise<T>;
  }

  /**
   * 把当前 VBK WebView 的 URL 用系统浏览器打开（仅 HTTP/HTTPS）。
   */
  async openExternal() {
    const url = this.view?.webContents.getURL() || "";
    await openExternalUrl(url, (value) => shell.openExternal(value));
  }

  /**
   * 内置 WebView 内导航；具体校验 / beforeunload 处理 / ERR_ABORTED 兜底逻辑
   * 全部由 ./vbk-navigation.js 的 navigateVbkPage 承担。
   *
   * 该方法仅做接线，不再重复白名单 / 事件监听 / 错误归一化逻辑：
   *   - 调用期间临时挂 will-prevent-unload 监听，event.preventDefault() 放行；
   *   - ERR_ABORTED 但已抵达目标时视作成功（容忍尾斜杠 / hash 差异）；
   *   - 仍未到目标时抛含 source / target / code 的明确错误；
   *   - 监听器 finally 清理，永不全局永久忽略 beforeunload；
   *   - 不无限重试。
   */
  async navigate(url: string) {
    await navigateVbkPage(this.view?.webContents, url);
  }

  /**
   * 便捷登录入口：setVisible(true) + 跳到产品列表 URL。
   */
  async login() { this.setVisible(true); await this.navigate(URLS.list); }

  // ─────────────────────────────────────────────────────────────
  // 多账号操作
  // ─────────────────────────────────────────────────────────────

  /**
   * 退出当前账号但**不**影响其他已记录账号：
   * 1. 清空当前活跃 view 的 partition 所有 storage 与缓存；
   * 2. 切换到默认视图并导航到产品列表；
   * 3. 清除活跃账号指针。
   */
  async logout() {
    const current = this.view;
    if (!current) return;
    await this.clearViewStorage(current);
    this.sessionStore?.clearActiveAccountKey();
    // 切回默认视图
    if (this.defaultView) {
      this.activateView(this.defaultView);
      await this.defaultView.webContents.loadURL(URLS.list);
    } else {
      this.activeKey = undefined;
    }
  }

  /**
   * 把当前 WebView 的 cookies 抽出来保存到本机（本地 0600 JSON cookie-store）。
   * 通常由 addLogin / switchAccount 在切换之前调用，账号未登录时直接 no-op。
   *
   * 写入失败的处理：
   *   - store 抛错（磁盘满、权限被改、JSON 损坏等）→ catch + console.warn，
   *     返回 null。调用方（IPC handler / 内部 fire-and-forget）已经各自
   *     catch 住，UI 不会看到未处理的 promise rejection。
   *   - 这里的 await 是契约的一部分：调用方可以同步依赖 saveSession
   *     在本函数返回前完成（fire-and-forget 的 .then/.catch 仍生效）。
   */
  async saveCurrentSession(): Promise<SavedLoginAccount | null> {
    if (!this.view) return null;
    if (!this.sessionStore) return null;
    const cookies = await this.collectCookies();
    if (cookies.length === 0) return null;
    const authSummary = summarizeVbkAuthCookies(cookies);
    if (!isVbkAuthCookieSummaryComplete(authSummary)) return null;
    // 「当前是谁」需要在抽 cookie 之前就探测完，否则页面看到的还是上一会话的 UI。
    const status = await this.status(false);
    if (!status.loggedIn) return null;
    const displayName = status.accountName || "已登录账号";
    const key = status.loginAccount || displayName;
    const cookiesJson = JSON.stringify(cookies);
    try {
      // 必须 await：addLogin / switchAccount 路径依赖同步感知写入完成；
      // withKnownVbkAccount 路径通过外层 .catch(...) 兜底。这里再次 try/catch
      // 是为了让 saveCurrentSession 自身永不让 IPC handler 抛错，避免
      // 「重新登录后用户啥也没看见但写盘失败」的沉默失败 —— 失败时已 console.warn，
      // 后续 status() 会重新触发 saveCurrentSession 再试一次。
      await Promise.resolve(this.sessionStore.saveSession(key, displayName, cookiesJson));
    } catch (error) {
      console.warn("[vbk] failed to persist session cookies; user will need to re-login", {
        accountKey: key,
        message: (error as { message?: string })?.message ?? "unknown",
      });
      return null;
    }
    this.sessionStore.setActiveAccountKey(key);
    return { accountKey: key, accountName: displayName, lastUsedAt: new Date().toISOString() };
  }

  /**
   * "新增登录"流程：
   *  1. 当前已登录 → 先 saveCurrentSession 把老账号 cookies 收进 DB；
   *  2. 清空默认视图的 storage / cache；
   *  3. 切换到默认视图并导航到 VBK 登录页；
   *  4. 等用户在右侧 WebView 完成新账号登录；
   *  5. status() 检测到新登录后会调 saveCurrentSession()（在 withKnownVbkAccount 钩子里），
   *     之后首次 switchAccount 时会自动创建 partition 视图并完成迁移。
   */
  async addLogin() {
    // 先把当前账号抓走；如果未登录，跳过这一步避免空快照落地。
    await this.saveCurrentSession();

    if (!this.defaultView) return;

    // 清空默认视图，准备承接新登录
    await this.clearViewStorage(this.defaultView);
    this.sessionStore?.clearActiveAccountKey();

    // 切换到默认视图
    this.activateView(this.defaultView);

    // 让登录页面尽可能快显示：使用轻量入口 URL 而不是产品库。
    await this.defaultView.webContents.loadURL("https://vbooking.ctrip.com/");
  }

  /**
   * 切换到本机已记着的一个 VBK 账号：
   *  1. 当前已登录 → saveCurrentSession 把老账号存进 DB；
   *  2. 获取/创建目标账号的 partition 视图（首次创建时从 DB 迁移 cookies）；
   *  3. 切换视图并导航到产品列表。
   *
   * 与旧版的关键区别：不再逐个 cookie 清除后回灌 —— partition 天然隔离，
   * 每个账号的 cookies 由 Electron 自动持久化，仅首次创建视图时需要一次 DB→partition
   * 的 cookie 迁移。
   */
  async switchAccount(accountKey: string) {
    if (!this.sessionStore) throw new Error("本机未启用多账号登录切换。");
    const trimmedKey = accountKey?.trim();
    if (!trimmedKey) throw new Error("切换账号失败：账号标识不能为空。");
    const record = this.sessionStore.loadSession(trimmedKey);
    if (!record) throw new Error(`本机未记录该 VBK 账号（${trimmedKey}），请先登录一次再切换。`);
    const cookies = parseCookies(record.cookiesJson);
    if (cookies.length === 0) {
      throw new Error(`本机没有该 VBK 账号（${trimmedKey}）可恢复的登录快照，请重新登录后再切换。`);
    }
    const authSummary = summarizeVbkAuthCookies(cookies);
    if (!isVbkAuthCookieSummaryComplete(authSummary)) {
      throw new Error(VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE);
    }

    await this.saveCurrentSession();

    // 获取或创建 partition 视图（首次时自动从 DB 迁移 cookies）
    const view = await this.ensureAccountView(trimmedKey, cookies);

    // 切换到目标视图
    this.activateView(view, trimmedKey);
    await view.webContents.loadURL(URLS.list);
  }

  /**
   * 忘记（删除）一个本机记着的账号快照。
   * 删除后运营再点该 chip 不会切回去 —— 调用方需负责提示。
   * WebView 当前正在展示的账号不允许忘记，否则会被一个已删除的记录
   * 立刻「复活」导致删除语义不一致。
   *
   * 同时清除该账号的 partition 持久化存储，彻底移除所有痕迹。
   */
  forgetAccount(accountKey: string) {
    if (!this.sessionStore) throw new Error("本机未启用多账号登录切换。");
    const trimmedKey = accountKey?.trim();
    if (!trimmedKey) return;
    const active = this.sessionStore.getActiveAccountKey();
    if (active && active === trimmedKey) {
      throw new Error("当前正在使用的账号不能直接忘记，请先切换或登出。");
    }

    // 清除 partition 持久化存储
    const partition = this.getPartition(trimmedKey);
    const ses = session.fromPartition(partition);
    ses.clearStorageData().catch(() => undefined);
    ses.clearCache().catch(() => undefined);

    // 销毁视图（如果已创建过）
    const view = this.accounts.get(trimmedKey);
    if (view) {
      try { view.webContents.close(); } catch { /* 可能已关闭 */ }
      this.accounts.delete(trimmedKey);
    }

    // 删除 DB 记录
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

  // ─────────────────────────────────────────────────────────────
  // 登录状态检测
  // ─────────────────────────────────────────────────────────────

  async status(refresh = false) {
    if (!this.view) return { loggedIn: false, message: "VBK 浏览器尚未准备好。" };
    if (refresh) await this.navigate(URLS.list);
    const url = this.view.webContents.getURL();
    if (/login|passport/i.test(url)) return { loggedIn: false, message: "尚未登录 VBK。" };
    const productListVisible = await this.view.webContents.executeJavaScript(`
      document.body?.innerText?.includes("产品列表") === true
    `, true).catch(() => false);
    if (!productListVisible) return { loggedIn: false, message: "尚未登录 VBK。" };
    const authSummary = summarizeVbkAuthCookies(await this.collectCookies());
    if (!isVbkAuthCookieSummaryComplete(authSummary)) {
      return { loggedIn: false, message: VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE };
    }

    // 1) 优先：通过 VBK getCurrentUserInfo 接口拿真实账号名。
    //    同一页面 URL 下缓存结果，避免重复 HTTP（checkVbkLogin / withKnownVbkAccount
    //    等会在短时间内多次触发 status，每次都发一次 providerId 接口）。
    let accountName: string | undefined;
    let loginAccount: string | undefined;
    if (url === this.cachedUserInfoUrl && this.cachedUserInfo) {
      accountName = this.cachedUserInfo.displayName;
      loginAccount = this.cachedUserInfo.loginAccount;
    } else {
      try {
        const page = await this.page();
        const user = await fetchCurrentUserInfo(page);
        const display = user?.displayName?.trim();
        const login = user?.loginAccount?.trim();
        if (login) loginAccount = login;
        if (display) accountName = display;
        else if (login) accountName = login;
        // 成功抓取后缓存：下次同一 URL 不再走网络。
        if (accountName || loginAccount) {
          this.cachedUserInfoUrl = url;
          this.cachedUserInfo = { displayName: accountName, loginAccount };
        }
      } catch {
        // API 失败（CDP 未就绪、接口变更、网络异常）→ fallback 到 DOM 抓取
      }
    }

    // 2) Fallback：DOM 抓取 + 菜单白名单过滤。
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

  // ─────────────────────────────────────────────────────────────
  // Playwright / CDP
  // ─────────────────────────────────────────────────────────────

  /**
   * 拿一个绑定到当前 VBK WebView 的 Playwright Page：
   *   - 复用 this.cdp（CDP over debuggingPort），避免重复连接累积 WebSocket；
   *   - 优先按 view URL 匹配；找不到则取任意 ctrip.com 页面；
   *   - 完全拿不到时抛错让上层提示「请先登录 VBK」。
   */
  async page(): Promise<Page> {
    if (!this.cdp?.isConnected()) {
      this.cdp = await chromium.connectOverCDP(`http://127.0.0.1:${this.debuggingPort}`);
    }
    const pages = this.cdp.contexts().flatMap((context) => context.pages());
    const page = selectVbkPage(pages, this.view?.webContents.getURL() ?? "");
    if (!page) throw new Error("未找到嵌入式 VBK 页面，请先登录 VBK 后重试。");
    return page;
  }

  /**
   * 关闭 CDP 连接 + 销毁所有视图；用于完全退出应用前或调试热重启时。
   */
  async dispose() {
    if (this.cdp?.isConnected()) await this.cdp.close().catch(() => {});
    this.cdp = undefined;
    // 销毁所有 partition 视图
    for (const view of this.accounts.values()) {
      try { view.webContents.close(); } catch { /* 可能已关闭 */ }
    }
    this.accounts.clear();
    // 销毁默认视图
    if (this.defaultView) {
      try { this.defaultView.webContents.close(); } catch { /* 可能已关闭 */ }
      this.defaultView = undefined;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 页面就绪等待
  // ─────────────────────────────────────────────────────────────

  /**
   * 启动时等待当前 VBK 页面渲染出"产品列表"。
   * 进程重启后 loadURL 虽已完成，但 SPA 客户端路由、数据加载可能
   * 仍在进行；调用方在收到 true 后即可安全调用 status() 检测登录态。
   * 超时或页面跳转到登录页时返回 false。
   */
  async waitUntilReady(): Promise<boolean> {
    return waitForDomText(this.view?.webContents, "产品列表", 10_000);
  }

  // ─────────────────────────────────────────────────────────────
  // 内部辅助：视图配置
  // ─────────────────────────────────────────────────────────────

  /**
   * 抑制持久分区下 Chromium 默认启动的 WebRTC ICE 副作用。
   * 每个新建的 view 都要调用一次。
   */
  private configureRtc(view: WebContentsView) {
    try {
      view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    } catch {
      // 极端旧 Electron（<13）无此 API 时静默跳过；当前依赖 ^43 必然存在。
    }
  }

  /** 给指定 view 安装导航白名单 + 外链打开走系统浏览器。 */
  private installNavigationHooks(view: WebContentsView) {
    view.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      const host = new URL(url).hostname;
      if (![...allowedHosts].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 内部辅助：cookie / storage 操作
  // ─────────────────────────────────────────────────────────────

  /** 清空指定 view 的所有 storage 与缓存。 */
  private async clearViewStorage(view: WebContentsView) {
    await view.webContents.session.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await view.webContents.session.clearCache();
  }

  /** 抽出当前活跃 view 的全部 cookies。空数组表示未登录或已被清空。 */
  private async collectCookies(): Promise<Electron.Cookie[]> {
    if (!this.view) return [];
    try {
      return await this.view.webContents.session.cookies.get({});
    } catch {
      return [];
    }
  }

  /**
   * 把单条 cookie（SerialisedCookie 格式，来自 DB）写回指定 view 的 session。
   */
  private async setCookieOn(view: WebContentsView, cookie: SerialisedCookie) {
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
    if (cookie.domain) details.domain = cookie.domain;
    try {
      await view.webContents.session.cookies.set(details);
    } catch {
      // 极少数 cookie（无效 domain / 跨 origin）写不进去，跳过。
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Cookie 序列化的具体归一化逻辑已拆到 ./vbk-cookie-serializer.ts，
// 这里只 import 用到的部分，避免单文件超过 400 行硬上限。
// ─────────────────────────────────────────────────────────────
