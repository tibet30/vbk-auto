import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url), "utf8");
const initialise = source.slice(source.indexOf("  async initialise()"), source.indexOf("  /**\n   * 调整 view 布局"));

test("无登录快照的活跃账号指针不会切换到空账号分区", () => {
  assert.match(initialise, /const record:[\s\S]*loadSession\(activeKey\)[\s\S]*const cookies = record \? parseCookies\(record\.cookiesJson\) : \[\];/);
  assert.match(initialise, /if \(activeKey && cookies\.length > 0\) \{[\s\S]*ensureAccountView\(activeKey, cookies\)[\s\S]*activateView\(view, activeKey\)/);
});

test("有效快照只读取一次并传入账号分区恢复流程", () => {
  assert.equal((initialise.match(/loadSession\(activeKey\)/g) ?? []).length, 1);
  assert.match(source, /private async ensureAccountView\(accountKey: string, cookies: SerialisedCookie\[\]\)/);
  assert.doesNotMatch(source, /ensureAccountView\(accountKey: string\)[\s\S]*loadSession\(accountKey\)/);
});

test("手动切换也拒绝空快照，不能激活空账号分区", () => {
  const switchAccount = source.slice(source.indexOf("  async switchAccount("), source.indexOf("  /**\n   * 忘记"));
  assert.match(switchAccount, /const cookies = parseCookies\(record\.cookiesJson\);[\s\S]*if \(cookies\.length === 0\) \{[\s\S]*throw new Error/);
  assert.match(switchAccount, /ensureAccountView\(trimmedKey, cookies\)/);
});

test("退出账号先卸载活跃分区视图，再清空内存活跃标识", () => {
  const logout = source.slice(source.indexOf("  async logout()"), source.indexOf("  /**\n   * 把当前 WebView"));
  assert.match(logout, /if \(this\.defaultView\) \{[\s\S]*this\.activateView\(this\.defaultView\);[\s\S]*\} else \{\s*this\.activeKey = undefined;/);
  assert.doesNotMatch(logout, /clearActiveAccountKey\(\);\s*this\.activeKey = undefined;\s*\/\/ 切回默认视图/);
});
