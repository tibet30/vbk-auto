import assert from "node:assert/strict";
import test from "node:test";
import { AppUpdateFailure, describeUpdateFailure, sanitizeUpdateStateForExport } from "../../src/main/application/app-update-diagnostics.js";

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

test("sanitizeUpdateStateForExport 仅脱敏 errorDetail 字段，不动 feedUrl / installerPath", () => {
  // AppUpdateState 出口 (safeRendererSend 'updates:changed' + IPC 返值) 之前
  // 必走这一道。errorDetail 来自 raw Error.message / stack，可能含 URL token
  // / 调试 key；feedUrl / installerPath 是自建 URL + 本地路径，保留原样。
  const raw = {
    currentVersion: "1.1.19",
    platform: "darwin",
    feedUrl: "https://updater.test/feed",
    installerPath: "/Users/cisco/Downloads/vbk.dmg",
    errorDetail: "fetch failed: https://updater.test/feed?token=secret-abc123&apiKey=sk-leak-9876",
  };
  const safe = sanitizeUpdateStateForExport(raw);
  for (const secret of ["secret-abc123", "sk-leak-9876"]) {
    assert.equal(safe.errorDetail?.includes(secret), false, secret);
  }
  assert.match(safe.errorDetail ?? "", /\[已脱敏\]/);
  // feedUrl / installerPath 不在脱敏范围。
  assert.equal(safe.feedUrl, raw.feedUrl);
  assert.equal(safe.installerPath, raw.installerPath);
});

test("sanitizeUpdateStateForExport 在 errorDetail 为空时原样返回", () => {
  const raw = { currentVersion: "1.1.19", errorDetail: undefined };
  const safe = sanitizeUpdateStateForExport(raw);
  assert.equal(safe, raw);
});
