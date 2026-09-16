import assert from "node:assert/strict";
import test from "node:test";
import { AppUpdateFailure, describeUpdateFailure } from "../../src/main/application/app-update-diagnostics.js";

test("自定义 AppUpdateFailure 保留分类码、中文说明与技术细节", () => {
  const failure = describeUpdateFailure(
    new AppUpdateFailure("feed_missing", "更新源上还没有 latest-mac.yml。", "HTTP 404"),
  );
  assert.equal(failure.code, "feed_missing");
  assert.equal(failure.message, "更新源上还没有 latest-mac.yml。");
  assert.equal(failure.detail, "HTTP 404");
});

test("网络类异常归到 feed_unreachable，并保留原文到 detail", () => {
  const failure = describeUpdateFailure(new Error("fetch failed: getaddrinfo ENOTFOUND www.atdtour.com"));
  assert.equal(failure.code, "feed_unreachable");
  assert.match(failure.message, /网络/);
  assert.match(failure.detail ?? "", /ENOTFOUND/);
});

test("electron-updater 的 semver 报错被翻译成中文，不再直接暴露英文原文", () => {
  const failure = describeUpdateFailure(
    new Error('This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: "undefined"'),
  );
  assert.equal(failure.code, "manifest_invalid");
  assert.doesNotMatch(failure.message, /semver/);
  assert.match(failure.message, /版本号/);
});

test("未知异常有兜底分类，主文案始终可读", () => {
  const failure = describeUpdateFailure("boom");
  assert.equal(failure.code, "unknown");
  assert.match(failure.message, /稍后重试/);
  assert.equal(failure.detail, "boom");
});
