/**
 * VBK 登录入口契约
 * ================
 *
 * 未登录（首次运行 / 会话过期）时直接请求产品列表页，VBK 返回的是携程 500 错误页
 * 「很抱歉，程序有误，需要重新选择目的地。」，**不会** 302 到登录页 —— 用户点
 * 「登录」却停在错误页就是这个原因。因此：
 *   - 登录入口固定使用带 backurl 的 accountV2 登录页，登录成功后自动回列表；
 *   - 没有已保存账号会话时的默认入口（初始页 / 登出 / 空白页引导）也是登录页。
 *
 * 断言含源码接线白盒检查（与仓库既有启动期契约测试同风格）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URLS } from "../../src/main/automation/constants.js";
import { isVbkLoginEntryArrival, isVbkLoginPage, vbkEntryUrl } from "../../src/main/infrastructure/vbk-navigation.js";

const browserSource = readFileSync(new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url), "utf8");
const accountsSource = readFileSync(new URL("../../src/main/infrastructure/vbk-browser-accounts.ts", import.meta.url), "utf8");

test("登录入口必须是带 backurl 的 accountV2 登录页", () => {
  const parsed = new URL(URLS.login);
  assert.equal(parsed.origin, "https://vbooking.ctrip.com");
  assert.equal(parsed.pathname, "/ivbk/accountV2/login");
  assert.equal(parsed.searchParams.get("backurl"), URLS.list, "登录后必须能回到产品列表");
});

test("isVbkLoginPage 只认携程域下的登录页路径", () => {
  assert.equal(isVbkLoginPage(URLS.login), true);
  assert.equal(isVbkLoginPage("https://vbooking.ctrip.com/ivbk/accountV2/login"), true);
  assert.equal(isVbkLoginPage(URLS.list), false);
  assert.equal(isVbkLoginPage("https://evil.example/ivbk/accountV2/login"), false);
  assert.equal(isVbkLoginPage("about:blank"), false);
});

test("登录入口导航的抵达判定容忍回到列表页，但不放过跑偏的页面", () => {
  assert.equal(isVbkLoginEntryArrival(URLS.login, URLS.login), true, "停在登录页算抵达");
  assert.equal(isVbkLoginEntryArrival(URLS.login, URLS.list), true, "已有会话直接回列表算抵达");
  assert.equal(
    isVbkLoginEntryArrival(URLS.login, "https://vbooking.ctrip.com/ivbk/accountV2/login?backurl=" + encodeURIComponent(URLS.list)),
    true,
    "服务端补齐 backurl 仍算抵达",
  );
  assert.equal(
    isVbkLoginEntryArrival(URLS.login, "https://vbooking.ctrip.com/product/input/otherPage"),
    false,
    "跑到无关页面必须视为导航失败",
  );
});

test("没有已保存账号会话时入口是登录页，有会话时回产品列表", () => {
  assert.equal(vbkEntryUrl(false), URLS.login);
  assert.equal(vbkEntryUrl(true), URLS.list);
});

test("登录按钮、初始页、登出与添加账号都落到登录页", () => {
  const loginBody = browserSource.slice(browserSource.indexOf("async login()"), browserSource.indexOf("logout()"));
  assert.match(loginBody, /URLS\.login/, "登录按钮必须直接打开登录页");
  assert.doesNotMatch(loginBody, /URLS\.list/, "未登录时列表页只会返回携程 500 错误页");

  const entryUses = browserSource.match(/this\.views\.entryUrl\(\)/g) ?? [];
  assert.ok(entryUses.length >= 2, "初始页与空白页引导都必须用 entryUrl()");

  const logoutBody = accountsSource.slice(
    accountsSource.indexOf("async logout()"),
    accountsSource.indexOf("async saveCurrentSession()"),
  );
  assert.match(logoutBody, /this\.views\.entryUrl\(\)/, "登出后应回到登录页");

  const addLoginBody = accountsSource.slice(
    accountsSource.indexOf("async addLogin()"),
    accountsSource.indexOf("async switchAccount("),
  );
  assert.match(addLoginBody, /URLS\.login/, "添加账号应直接打开登录页");
  assert.doesNotMatch(addLoginBody, /loadURL\("https:\/\/vbooking\.ctrip\.com\/"\)/, "不得只打开 VBK 根页面");
});
