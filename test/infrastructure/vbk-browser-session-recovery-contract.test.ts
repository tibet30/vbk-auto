import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../src/main/main.ts", import.meta.url), "utf8");
const accountStatusSource = readFileSync(new URL("../../src/main/infrastructure/vbk-account-status.ts", import.meta.url), "utf8");
const initialise = source.slice(source.indexOf("  async initialise()"), source.indexOf("  /**\n   * 调整 view 布局"));

test("无登录快照的活跃账号指针不会切换到空账号分区", () => {
  assert.match(initialise, /const record:[\s\S]*loadSession\(activeKey\)[\s\S]*const cookies = record \? parseCookies\(record\.cookiesJson\) : \[\];/);
  assert.match(initialise, /const authSummary = summarizeVbkAuthCookies\(cookies\);/);
  assert.match(initialise, /if \(activeKey && cookies\.length > 0 && isVbkAuthCookieSummaryComplete\(authSummary\)\) \{[\s\S]*ensureAccountView\(activeKey, cookies\)[\s\S]*activateView\(view, activeKey\)/);
});

test("有效快照只读取一次并传入账号分区恢复流程", () => {
  assert.equal((initialise.match(/loadSession\(activeKey\)/g) ?? []).length, 1);
  assert.match(source, /private async ensureAccountView\(accountKey: string, cookies: SerialisedCookie\[\]\)/);
  assert.doesNotMatch(source, /ensureAccountView\(accountKey: string\)[\s\S]*loadSession\(accountKey\)/);
});

test("手动切换也拒绝空快照，不能激活空账号分区", () => {
  const switchAccount = source.slice(source.indexOf("  async switchAccount("), source.indexOf("  /**\n   * 忘记"));
  assert.match(source, /private resolveSessionKey\(identifier: string\): string[\s\S]*listSessions\(\)\.filter\([\s\S]*accountName === identifier/);
  assert.match(switchAccount, /const cookies = parseCookies\(record\.cookiesJson\);[\s\S]*if \(cookies\.length === 0\) \{[\s\S]*throw new Error/);
  assert.match(switchAccount, /const authSummary = summarizeVbkAuthCookies\(cookies\);[\s\S]*isVbkAuthCookieSummaryComplete\(authSummary\)/);
  assert.match(switchAccount, /ensureAccountView\(trimmedKey, cookies\)/);
});

test("退出账号先卸载活跃分区视图，再清空内存活跃标识", () => {
  const logout = source.slice(source.indexOf("  async logout()"), source.indexOf("  /**\n   * 把当前 WebView"));
  assert.match(logout, /if \(this\.defaultView\) \{[\s\S]*this\.activateView\(this\.defaultView\);[\s\S]*\} else \{\s*this\.activeKey = undefined;/);
  assert.doesNotMatch(logout, /clearActiveAccountKey\(\);\s*this\.activeKey = undefined;\s*\/\/ 切回默认视图/);
});

test("保存和状态检测都必须先校验 VBK 鉴权 cookie 完整性", () => {
  const saveCurrentSession = source.slice(source.indexOf("  async saveCurrentSession()"), source.indexOf("  /**\n   * \"新增登录\""));
  const status = source.slice(source.indexOf("  async status("), source.indexOf("  // ─────────────────────────────────────────────────────────────\n  // Playwright"));
  assert.match(saveCurrentSession, /const authSummary = summarizeVbkAuthCookies\(cookies\);[\s\S]*if \(!isVbkAuthCookieSummaryComplete\(authSummary\)\) return null;/);
  assert.match(status, /const authSummary = summarizeVbkAuthCookies\(await this\.collectCookies\(\)\);[\s\S]*VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE/);
});

test("withKnownVbkAccount 只在真实保存成功后写入活跃账号 key", () => {
  const withKnown = accountStatusSource.slice(accountStatusSource.indexOf("export function createWithKnownVbkAccount"));
  assert.match(withKnown, /if \(!saved\) return;[\s\S]*db\.setSetting\("vbkActiveAccountKey", saved\.accountKey\);/);
  assert.doesNotMatch(withKnown, /else if \(snapshotKey\) db\.setSetting\("vbkActiveAccountKey"/);
});

// ───────────────────────── safeStorage removal contract ─────────────────────────

test("生产代码不导入 safeStorage / secure-storage 适配器", () => {
  // main.ts 与 vbk-browser.ts 必须不再 import 'electron.safeStorage'，
  // 也不再引用 ./infrastructure/secure-storage.js（已删除）。任何残留
  // 都意味着迁移未完成，IPC handler 会因为缺导入而 fail。
  assert.doesNotMatch(mainSource, /from\s+["']electron["'][^;]*safeStorage/, "main.ts 不能再 import safeStorage");
  assert.doesNotMatch(mainSource, /from\s+["'].*secure-storage["']/, "main.ts 不能再引用 secure-storage adapter");
  assert.doesNotMatch(mainSource, /safeStorage\./, "main.ts 不能再调用 safeStorage.* API");
  assert.doesNotMatch(source, /from\s+["']electron["'][^;]*safeStorage/, "vbk-browser.ts 不能再 import safeStorage");
  assert.doesNotMatch(source, /safeStorage\./, "vbk-browser.ts 不能再调用 safeStorage.* API");
  // saveCurrentSession 必须通过 cookieStore 落盘；不再有 encryptString / decryptString 残留。
  assert.doesNotMatch(mainSource, /encryptString|decryptString|isProbablyEncrypted/, "main.ts 不能再调用 secure-storage 的 encryptString / decryptString / isProbablyEncrypted");
});

test("saveCurrentSession：await 持久化 + catch 保存失败", () => {
  const saveCurrentSession = source.slice(source.indexOf("  async saveCurrentSession()"), source.indexOf("  /**\n   * \"新增登录\""));
  // 必须 await store 的 saveSession，确保同步感知写入完成。
  assert.match(saveCurrentSession, /await\s+Promise\.resolve\(this\.sessionStore\.saveSession/);
  // store 抛错时 saveCurrentSession 自身不应再抛（catch + warn + 返回 null）。
  // logWarn / console.warn 都会被认作可观测 warn 出口。
  assert.match(saveCurrentSession, /catch\s*\([\s\S]*?(console\.warn|logWarn)\([\s\S]*?return null;/);
});

test("迟到的旧视图保存不能覆盖切换后的活跃账号", () => {
  const saveCurrentSession = source.slice(source.indexOf("  async saveCurrentSession()"), source.indexOf("  /**\n   * \"新增登录\""));
  assert.match(saveCurrentSession, /const sourceView = this\.view;[\s\S]*const sourceKey = this\.activeKey;/);
  assert.match(saveCurrentSession, /collectCookies\(sourceView\)[\s\S]*this\.view !== sourceView \|\| this\.activeKey !== sourceKey/);
  assert.match(saveCurrentSession, /fetchCurrentUserInfoInView\(sourceView\)[\s\S]*if \(sourceKey && key !== sourceKey\)[\s\S]*return null;/);
  assert.match(saveCurrentSession, /if \(this\.view === sourceView && this\.activeKey === sourceKey\) \{[\s\S]*setActiveAccountKey\(key\)/);
});

test("切换账号先验证目标视图真实身份，再提交活动账号", () => {
  const switchAccount = source.slice(source.indexOf("  async switchAccount("), source.indexOf("  /**\n   * 新数据始终传"));
  const verifyAt = switchAccount.indexOf("fetchCurrentUserInfoInView(view)");
  const activateAt = switchAccount.indexOf("this.activateView(view, trimmedKey)");
  assert.ok(verifyAt >= 0, "切换必须读取目标 WebContentsView 的真实账号");
  assert.ok(activateAt > verifyAt, "只有身份校验成功后才能激活目标视图");
  assert.match(switchAccount, /restoredUser\?\.loginAccount !== trimmedKey[\s\S]*throw new Error/);
});

test("addLogin / switchAccount 都 await saveCurrentSession", () => {
  const addLogin = source.slice(source.indexOf("  async addLogin()"), source.indexOf("  /**\n   * 切换"));
  const switchAccount = source.slice(source.indexOf("  async switchAccount("), source.indexOf("  /**\n   * 忘记"));
  assert.match(addLogin, /await this\.saveCurrentSession\(\);/, "addLogin must await saveCurrentSession");
  assert.match(switchAccount, /await this\.saveCurrentSession\(\);/, "switchAccount must await saveCurrentSession");
});

test("新增登录 / 切换账号不会复用上一个账号的 current-user 缓存", () => {
  const activateView = source.slice(source.indexOf("  private activateView("), source.indexOf("  // ─────────────────────────────────────────────────────────────\n  // 生命周期"));
  const installNavigationHooks = source.slice(source.indexOf("  private installNavigationHooks("), source.indexOf("  // ─────────────────────────────────────────────────────────────\n  // 内部辅助：cookie"));
  const clearViewStorage = source.slice(source.indexOf("  private async clearViewStorage("), source.indexOf("  /** 抽出当前活跃 view"));
  assert.match(source, /private clearCachedUserInfo\(\): void \{[\s\S]*cachedUserInfoUrl = undefined;[\s\S]*cachedUserInfo = undefined;/);
  assert.match(source, /cachedUserInfoWebContentsId/);
  assert.match(source, /fetchCurrentUserInfoInView\(this\.view\)/);
  assert.match(activateView, /if \(current !== view \|\| this\.activeKey !== nextKey\) this\.clearCachedUserInfo\(\);/);
  assert.match(installNavigationHooks, /did-start-navigation[\s\S]*this\.clearCachedUserInfo\(\);/);
  assert.match(installNavigationHooks, /did-navigate-in-page[\s\S]*this\.clearCachedUserInfo\(\);/);
  assert.match(clearViewStorage, /this\.clearCachedUserInfo\(\);[\s\S]*clearStorageData[\s\S]*clearCache\(\);[\s\S]*this\.clearCachedUserInfo\(\);/);
});

test("withKnownVbkAccount：saveCurrentSession 失败被 .catch 吞掉，不会变 unhandled rejection", () => {
  const withKnown = accountStatusSource.slice(accountStatusSource.indexOf("export function createWithKnownVbkAccount"));
  // 必须 Promise 链 + .catch，禁止裸 fire-and-forget。
  assert.match(withKnown, /browser\.saveCurrentSession\(\)/);
  assert.match(withKnown, /\.catch\(/, "saveCurrentSession 必须有 .catch 兜底");
});
