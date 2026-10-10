import { logWarn } from "../../shared/log-timestamp.js";
import type { LoginAccountsSnapshot, SavedLoginAccount } from "../../shared/contracts-types.js";
import { URLS } from "../automation/constants.js";
import { parseCookies } from "./vbk-cookie-serializer.js";
import {
  VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE,
  isVbkAuthCookieSummaryComplete,
  summarizeVbkAuthCookies,
} from "./vbk-auth-cookies.js";
import type { LoginSessionStore } from "./vbk-browser-types.js";
import type { VbkBrowserViewManager } from "./vbk-browser-view-manager.js";

export class VbkBrowserAccounts {
  constructor(
    private readonly views: VbkBrowserViewManager,
    private readonly sessionStore: LoginSessionStore | undefined,
    private readonly ensureReady: () => Promise<void>,
    private readonly disposeCapture: () => void,
    private readonly ensureInitialPage: () => Promise<void>,
  ) {}

  async logout(): Promise<void> {
    await this.ensureReady();
    this.disposeCapture();
    const current = this.views.view;
    if (!current) return;
    await this.views.clearViewStorage(current);
    this.sessionStore?.clearActiveAccountKey();
    const defaultView = this.views.ensureDefaultView();
    this.views.activateView(defaultView);
    await defaultView.webContents.loadURL(URLS.list);
  }

  async saveCurrentSession(): Promise<SavedLoginAccount | null> {
    const sourceView = this.views.view;
    const sourceKey = this.views.activeKey;
    if (!sourceView || !this.sessionStore) return null;
    const cookies = await this.views.collectCookies(sourceView);
    if (!cookies.length || this.views.view !== sourceView || this.views.activeKey !== sourceKey) return null;
    if (!isVbkAuthCookieSummaryComplete(summarizeVbkAuthCookies(cookies))) return null;
    const user = await this.views.fetchCurrentUserInfoInView(sourceView).catch(() => null);
    const key = user?.loginAccount?.trim();
    if (!key) return null;
    if (sourceKey && key !== sourceKey) {
      logWarn("[vbk] refused to overwrite session with mismatched browser identity", {
        expectedAccountKey: sourceKey,
        actualAccountKey: key,
      });
      return null;
    }
    const displayName = user?.displayName?.trim() || key;
    try {
      await Promise.resolve(this.sessionStore.saveSession(key, displayName, JSON.stringify(cookies)));
    } catch (error) {
      logWarn("[vbk] failed to persist session cookies; user will need to re-login", {
        accountKey: key,
        message: (error as { message?: string })?.message ?? "unknown",
      });
      return null;
    }
    if (this.views.view === sourceView && this.views.activeKey === sourceKey) {
      this.sessionStore.setActiveAccountKey(key);
    }
    return { accountKey: key, accountName: displayName, lastUsedAt: new Date().toISOString() };
  }

  async addLogin(): Promise<void> {
    await this.ensureReady();
    this.disposeCapture();
    await this.saveCurrentSession();
    const defaultView = this.views.ensureDefaultView();
    await this.views.clearViewStorage(defaultView);
    this.sessionStore?.clearActiveAccountKey();
    this.views.activateView(defaultView);
    await defaultView.webContents.loadURL("https://vbooking.ctrip.com/");
  }

  async switchAccount(accountKey: string): Promise<void> {
    await this.ensureReady();
    this.disposeCapture();
    if (!this.sessionStore) throw new Error("本机未启用多账号登录切换。");
    const requestedKey = accountKey?.trim();
    if (!requestedKey) throw new Error("切换账号失败：账号标识不能为空。");
    const key = this.resolveSessionKey(requestedKey);
    const record = this.sessionStore.loadSession(key);
    if (!record) throw new Error(`本机未记录该 VBK 账号（${requestedKey}），请先登录一次再切换。`);
    const cookies = parseCookies(record.cookiesJson);
    if (!cookies.length) throw new Error(`本机没有该 VBK 账号（${key}）可恢复的登录快照，请重新登录后再切换。`);
    if (!isVbkAuthCookieSummaryComplete(summarizeVbkAuthCookies(cookies))) {
      throw new Error(VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE);
    }
    const sourceKey = this.views.activeKey;
    const savedCurrent = await this.saveCurrentSession();
    if (sourceKey === key && savedCurrent?.accountKey === key) return;
    const view = await this.views.ensureAccountView(key, cookies);
    const restoredUser = await this.views.fetchCurrentUserInfoInView(view).catch(() => null);
    if (restoredUser?.loginAccount !== key) {
      throw new Error(`切换账号失败：本机快照属于 ${restoredUser?.loginAccount || "未知账号"}，与目标 ${key} 不一致，请重新登录该账号。`);
    }
    this.views.activateView(view, key);
    if (this.views.visible) {
      void this.ensureInitialPage().catch((error) => logWarn("[vbk] switched account page load failed", error));
    }
  }

  forgetAccount(accountKey: string): void {
    if (!this.sessionStore) throw new Error("本机未启用多账号登录切换。");
    const key = accountKey?.trim();
    if (!key) return;
    if (this.sessionStore.getActiveAccountKey() === key) {
      throw new Error("当前正在使用的账号不能直接忘记，请先切换或登出。");
    }
    this.views.forgetPartition(key);
    this.sessionStore.deleteSession(key);
  }

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

  async status(initialise: (refresh: boolean) => Promise<{ ready: boolean; message?: string }>, refresh = false) {
    const state = await initialise(refresh);
    if (!state.ready) return { loggedIn: false, message: state.message ?? "VBK 浏览器正在准备中。" };
    const checkedView = this.views.view;
    if (!checkedView) return { loggedIn: false, message: "VBK 浏览器尚未准备好。" };
    const url = checkedView.webContents.getURL();
    const authSummary = summarizeVbkAuthCookies(await this.views.collectCookies(checkedView));
    if (!isVbkAuthCookieSummaryComplete(authSummary)) {
      return { loggedIn: false, message: VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE };
    }
    let accountName: string | undefined;
    let loginAccount: string | undefined;
    const webContentsId = checkedView.webContents.id;
    const cached = !refresh ? this.views.cachedUser(url, webContentsId) : undefined;
    if (cached) {
      accountName = cached.displayName;
      loginAccount = cached.loginAccount;
    } else {
      try {
        const user = await this.views.fetchCurrentUserInfoInView(checkedView);
        loginAccount = user?.loginAccount?.trim() || undefined;
        accountName = user?.displayName?.trim() || loginAccount;
        if (accountName || loginAccount) {
          this.views.cacheUser(url, webContentsId, { displayName: accountName, loginAccount });
        }
      } catch { this.views.clearCachedUserInfo(); }
    }
    if (this.views.view !== checkedView || checkedView.webContents.isDestroyed()) {
      this.views.clearCachedUserInfo();
      return { loggedIn: false, message: "登录核验期间账号已切换，请重新核验。" };
    }
    if (!loginAccount || !accountName) {
      this.views.clearCachedUserInfo();
      return { loggedIn: false, message: "VBK 登录会话未通过当前用户接口核验，请重新登录。" };
    }
    if (this.views.activeKey && loginAccount !== this.views.activeKey) {
      this.views.clearCachedUserInfo();
      return { loggedIn: false, message: "VBK 当前登录身份与账号分区不一致，请重新登录。" };
    }
    return {
      loggedIn: true,
      message: "VBK 已登录。",
      accountName,
      loginAccount,
      accounts: Array.from(new Set([accountName, loginAccount].filter(Boolean) as string[])),
    };
  }

  private resolveSessionKey(identifier: string): string {
    if (this.sessionStore?.loadSession(identifier)) return identifier;
    const matches = this.sessionStore?.listSessions().filter((entry) => entry.accountName === identifier) ?? [];
    return matches.length === 1 ? matches[0].accountKey : identifier;
  }
}
