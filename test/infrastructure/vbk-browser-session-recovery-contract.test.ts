import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readInfrastructure = (file: string) => readFileSync(
  new URL(`../../src/main/infrastructure/${file}`, import.meta.url),
  "utf8",
);
const facadeSource = readInfrastructure("vbk-browser.ts");
const accountSource = readInfrastructure("vbk-browser-accounts.ts");
const viewSource = readInfrastructure("vbk-browser-view-manager.ts");
const cookieHelperSource = readInfrastructure("vbk-browser-cookies.ts");
const mainSource = readFileSync(new URL("../../src/main/main.ts", import.meta.url), "utf8");
const accountStatusSource = readInfrastructure("vbk-account-status.ts");
const initialise = facadeSource.slice(
  facadeSource.indexOf("  private async initialiseOnce()"),
  facadeSource.indexOf("  private async ensureReadyForAction()"),
);
const saveCurrentSession = accountSource.slice(
  accountSource.indexOf("  async saveCurrentSession()"),
  accountSource.indexOf("  async addLogin()"),
);
const addLogin = accountSource.slice(
  accountSource.indexOf("  async addLogin()"),
  accountSource.indexOf("  async switchAccount("),
);
const switchAccount = accountSource.slice(
  accountSource.indexOf("  async switchAccount("),
  accountSource.indexOf("  forgetAccount("),
);
const logout = accountSource.slice(
  accountSource.indexOf("  async logout()"),
  accountSource.indexOf("  async saveCurrentSession()"),
);
const status = accountSource.slice(
  accountSource.indexOf("  async status("),
  accountSource.indexOf("  private resolveSessionKey("),
);

test("hidden VBK navigation cannot steal the renderer IME focus", () => {
  const createView = viewSource.slice(viewSource.indexOf("  createView("), viewSource.indexOf("  ensureDefaultView("));
  assert.match(createView, /webPreferences:\s*\{\s*partition,\s*focusOnNavigation:\s*false/);
});

test("初始化只在完整快照存在时恢复账号分区", () => {
  assert.equal((initialise.match(/loadSession\(activeKey\)/g) ?? []).length, 1);
  assert.match(initialise, /const cookies = record \? parseCookies\(record\.cookiesJson\) : \[\];/);
  assert.match(initialise, /isVbkAuthCookieSummaryComplete\(authSummary\)/);
  assert.match(initialise, /ensureAccountView\(activeKey, cookies\)[\s\S]*activateView\(view, activeKey\)/);
  assert.match(initialise, /else \{[\s\S]*ensureDefaultView\(\)/);
  assert.doesNotMatch(initialise, /createView\("persist:vbk"\)/);
});

test("账号分区恢复接收已验证 cookie，不自行重复读取 store", () => {
  const ensureAccount = viewSource.slice(
    viewSource.indexOf("  async ensureAccountView("),
    viewSource.indexOf("  activateView("),
  );
  assert.match(ensureAccount, /accountKey: string, cookies: SerialisedCookie\[\]/);
  assert.doesNotMatch(ensureAccount, /loadSession/);
});

test("新增登录、退出与切换均等待准备状态并按需创建默认视图", () => {
  assert.match(addLogin, /await this\.ensureReady\(\)/);
  assert.match(addLogin, /this\.views\.ensureDefaultView\(\)/);
  assert.match(logout, /await this\.ensureReady\(\)/);
  assert.match(logout, /clearActiveAccountKey\(\)[\s\S]*ensureDefaultView\(\)[\s\S]*activateView\(defaultView\)/);
  assert.match(switchAccount, /await this\.ensureReady\(\)/);
});

test("手动切换拒绝空或不完整快照，并在激活前核验真实身份", () => {
  assert.match(switchAccount, /const cookies = parseCookies\(record\.cookiesJson\);/);
  assert.match(switchAccount, /if \(!cookies\.length\) throw new Error/);
  assert.match(switchAccount, /isVbkAuthCookieSummaryComplete\(summarizeVbkAuthCookies\(cookies\)\)/);
  const verifyAt = switchAccount.indexOf("fetchCurrentUserInfoInView(view)");
  const activateAt = switchAccount.indexOf("this.views.activateView(view, key)");
  assert.ok(verifyAt >= 0 && activateAt > verifyAt);
  assert.match(switchAccount, /restoredUser\?\.loginAccount !== key/);
});

test("命中当前账号时先保存并验证，再直接复用", () => {
  assert.match(switchAccount, /const sourceKey = this\.views\.activeKey;[\s\S]*await this\.saveCurrentSession\(\)/);
  assert.match(switchAccount, /sourceKey === key && savedCurrent\?\.accountKey === key/);
  assert.ok(
    switchAccount.indexOf("savedCurrent?.accountKey === key") < switchAccount.indexOf("ensureAccountView(key, cookies)"),
  );
});

test("保存和状态检测均校验鉴权 cookie 完整性", () => {
  assert.match(saveCurrentSession, /isVbkAuthCookieSummaryComplete\(summarizeVbkAuthCookies\(cookies\)\)/);
  assert.match(status, /summarizeVbkAuthCookies\(await this\.views\.collectCookies\(checkedView\)\)/);
  assert.match(status, /VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE/);
});

test("session 保存 await 落盘、吞掉持久化错误，并阻止迟到视图抢占 active key", () => {
  assert.match(saveCurrentSession, /await Promise\.resolve\(this\.sessionStore\.saveSession/);
  assert.match(saveCurrentSession, /catch \(error\)[\s\S]*logWarn[\s\S]*return null/);
  assert.match(saveCurrentSession, /const sourceView = this\.views\.view;[\s\S]*const sourceKey = this\.views\.activeKey/);
  assert.match(saveCurrentSession, /this\.views\.view !== sourceView \|\| this\.views\.activeKey !== sourceKey/);
  assert.match(saveCurrentSession, /if \(this\.views\.view === sourceView && this\.views\.activeKey === sourceKey\)/);
});

test("addLogin / switchAccount 都 await saveCurrentSession", () => {
  assert.match(addLogin, /await this\.saveCurrentSession\(\)/);
  assert.match(switchAccount, /await this\.saveCurrentSession\(\)/);
});

test("跨视图、导航和清存储都会失效 current-user 缓存", () => {
  assert.match(viewSource, /if \(current !== view \|\| this\.activeKey !== nextKey\) this\.clearCachedUserInfo\(\)/);
  assert.match(viewSource, /did-start-navigation[\s\S]*clearCachedUserInfo/);
  assert.match(viewSource, /did-navigate-in-page[\s\S]*clearCachedUserInfo/);
  assert.match(viewSource, /clearViewStorage[\s\S]*clearCachedUserInfo\(\)[\s\S]*clearVbkViewStorage\(view\)[\s\S]*clearCachedUserInfo\(\)/);
  assert.match(cookieHelperSource, /clearStorageData[\s\S]*clearCache\(\)/);
});

test("导航钉住规则仍由 view manager 强制执行", () => {
  assert.match(viewSource, /isPinnedVbkNavigationAllowed\(url, this\.navigationPin\)/);
});

test("生产代码不导入 safeStorage 或遗留 secure-storage", () => {
  for (const source of [mainSource, facadeSource, accountSource, viewSource]) {
    assert.doesNotMatch(source, /from\s+["']electron["'][^;]*safeStorage/);
    assert.doesNotMatch(source, /safeStorage\.|secure-storage|encryptString|decryptString/);
  }
});

test("withKnownVbkAccount 只在真实保存成功后写 active key，并捕获异步错误", () => {
  const withKnown = accountStatusSource.slice(accountStatusSource.indexOf("export function createWithKnownVbkAccount"));
  assert.match(withKnown, /if \(!saved\) return;[\s\S]*db\.setSetting\("vbkActiveAccountKey", saved\.accountKey\)/);
  assert.match(withKnown, /browser\.saveCurrentSession\(\)[\s\S]*\.catch\(/);
});
