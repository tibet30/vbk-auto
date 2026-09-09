import test from "node:test";
import assert from "node:assert/strict";
import { resolveSystemNotificationsEnabled } from "../../src/shared/system-notification-settings.js";

test("系统通知对已有安装默认开启，只有明确关闭才禁用", () => {
  assert.equal(resolveSystemNotificationsEnabled(), true);
  assert.equal(resolveSystemNotificationsEnabled("true"), true);
  assert.equal(resolveSystemNotificationsEnabled("false"), false);
});
