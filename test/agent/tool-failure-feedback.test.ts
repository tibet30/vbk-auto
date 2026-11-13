import assert from "node:assert/strict";
import test from "node:test";
import { formatToolFailureForModel } from "../../src/main/agent/core-tools.js";
import { isVbkLoginExpiredMessage, withVbkLoginHint } from "../../src/main/infrastructure/vbk-login-error.js";

test("工具失败文案回传模型并提示最多再自调用一次", () => {
  const text = formatToolFailureForModel("query_poi", "VBK POI 查询失败：HTTP 430");
  assert.match(text, /^工具失败：VBK POI 查询失败：HTTP 430/);
  assert.match(text, /工具：query_poi/);
  assert.match(text, /最多再试一次/);
  assert.match(text, /ask_user/);
});

test("登录失效不回传「再试一次」，直接要求运营重新登录", () => {
  const text = formatToolFailureForModel(
    "generate_product_module",
    "推荐理由类别目录读取失败（Ack=Failure）：10007: 当前用户登录已失效,请重新登录。",
    false,
    true,
  );
  assert.match(text, /VBK 登录已失效，请重新登录 VBK 账号后继续。/);
  assert.match(text, /重试同一工具不会恢复/);
  assert.doesNotMatch(text, /最多再试一次/);
});

test("登录态失效只识别登录类文案，不吞掉网络或协议失败", () => {
  assert.equal(isVbkLoginExpiredMessage("10007: 当前用户登录已失效,请重新登录"), true);
  assert.equal(isVbkLoginExpiredMessage("10009: 当前用户未登录"), true);
  assert.equal(isVbkLoginExpiredMessage("getCurrentUserInfo 返回：凭证无效"), true);
  assert.equal(isVbkLoginExpiredMessage("推荐理由类别目录读取失败：HTTP 503"), false);
  assert.equal(isVbkLoginExpiredMessage("推荐理由类别目录没有有效分类。"), false);
});

test("登录处置话术只出现一次，平台链路与工具回传不重复追加", () => {
  const hinted = withVbkLoginHint("推荐理由类别目录读取失败（Ack=Failure）：10007: 当前用户登录已失效,请重新登录。");
  assert.equal(withVbkLoginHint(hinted), hinted, "已带话术的消息不再追加");

  const text = formatToolFailureForModel("generate_product_module", hinted, false, true);
  assert.equal(text.match(/VBK 登录已失效/g)?.length, 1);
  assert.equal(text.match(/重新登录 VBK 账号后继续/g)?.length, 1);
});
