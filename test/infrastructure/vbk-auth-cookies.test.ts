import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE,
  assertCompleteVbkAuthCookies,
  isVbkAuthCookieSummaryComplete,
  summarizeVbkAuthCookies,
} from "../../src/main/infrastructure/vbk-auth-cookies.js";

test("只有 GUID 和 UBT_VID 时登录态不完整", () => {
  const summary = summarizeVbkAuthCookies([
    { name: "GUID", domain: ".ctrip.com" },
    { name: "UBT_VID", domain: ".ctrip.com" },
  ]);
  assert.equal(isVbkAuthCookieSummaryComplete(summary), false);
  assert.deepEqual(summary.missingNames, ["vbkticket or bticket", "JSESSIONID"]);
});

test("vbkticket + JSESSIONID + GUID 是完整登录态", () => {
  const summary = summarizeVbkAuthCookies([
    { name: "vbkticket", domain: ".ctrip.com" },
    { name: "JSESSIONID", domain: "vbooking.ctrip.com" },
    { name: "GUID", domain: ".ctrip.com" },
  ]);
  assert.equal(isVbkAuthCookieSummaryComplete(summary), true);
  assert.deepEqual(summary.missingNames, []);
});

test("bticket + JSESSIONID + vbk_login_cid 是完整登录态", () => {
  const summary = summarizeVbkAuthCookies([
    { name: "bticket", domain: ".ctrip.com" },
    { name: "JSESSIONID", domain: "vbooking.ctrip.com" },
    { name: "vbk_login_cid", domain: ".ctrip.com" },
  ]);
  assert.equal(isVbkAuthCookieSummaryComplete(summary), true);
  assert.deepEqual(summary.missingNames, []);
});

test("missingNames 覆盖三类必需登录 cookie", () => {
  const summary = summarizeVbkAuthCookies([{ name: "JSESSIONID", domain: "vbooking.ctrip.com" }]);
  assert.deepEqual(summary.missingNames, ["vbkticket or bticket", "vbk_login_cid or GUID"]);
});

test("摘要不暴露 cookie value", () => {
  const summary = summarizeVbkAuthCookies([
    { name: "vbkticket", domain: ".ctrip.com", value: "secret-ticket" } as { name: string; domain: string },
  ]);
  assert.equal(JSON.stringify(summary).includes("secret-ticket"), false);
});

test("assertCompleteVbkAuthCookies 使用统一中文错误", () => {
  const summary = summarizeVbkAuthCookies([{ name: "GUID" }]);
  assert.throws(() => assertCompleteVbkAuthCookies(summary), new RegExp(VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE));
});
