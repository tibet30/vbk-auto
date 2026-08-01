import test from "node:test";
import assert from "node:assert/strict";
import { isOnlineStatus, isValidStatus } from "../src/main/automation/constants.js";

test("未上线不会被判定为已上线", () => {
  // 「未上线」包含「上线」子串，此前的 includes 判定会把它当成已上线，
  // 从而跳过上线操作并直接返回 published: true。
  assert.equal(isOnlineStatus("有效 未上线"), false);
  assert.equal(isOnlineStatus("待上线"), false);
  assert.equal(isOnlineStatus("已下线"), false);
});

test("真正上线的状态可以识别", () => {
  assert.equal(isOnlineStatus("有效 上线"), true);
  assert.equal(isOnlineStatus("上线中"), true);
});

test("无效与失效不会被判定为有效", () => {
  assert.equal(isValidStatus("无效 上线"), false);
  assert.equal(isValidStatus("已失效"), false);
  assert.equal(isValidStatus("有效"), true);
});
