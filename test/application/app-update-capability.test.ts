import assert from "node:assert/strict";
import test from "node:test";
import { resolveUpdateCapability } from "../../src/main/application/app-update-service/feed.js";
import { decideManifestUpdate } from "../../src/main/application/app-update-service/manifest.js";
import { diagnosticText, presentUpdate } from "../../src/renderer/app/update/update-presentation.js";
import type { AppUpdateState } from "../../src/shared/contracts.js";

function devState(patch: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: "1.1.28",
    platform: "darwin",
    supported: true,
    canInstall: false,
    feedUrl: "https://www.atdtour.com/downloads/sanrentongyou/updates/stable",
    status: "not_available",
    updateAvailable: false,
    serverVersion: "1.1.28",
    downloaded: false,
    ...patch,
  };
}

test("开发模式也能检查更新，但只有打包版能自动安装", () => {
  assert.deepEqual(resolveUpdateCapability("darwin", false), { supported: true, canInstall: false });
  assert.deepEqual(resolveUpdateCapability("darwin", true), { supported: true, canInstall: true });
  assert.deepEqual(resolveUpdateCapability("win32", false), { supported: true, canInstall: false });
  assert.deepEqual(resolveUpdateCapability("linux", true), { supported: false, canInstall: false });
});

test("清单与当前版本一致时仍带回服务器版本号", () => {
  const decision = decideManifestUpdate({ version: "1.1.28" }, "1.1.28");
  assert.equal(decision.serverVersion, "1.1.28");
  assert.equal(decision.updateAvailable, false);
  assert.equal(decision.availableVersion, undefined);
});

test("清单更高版本时同时带回服务器版本与可更新版本", () => {
  const decision = decideManifestUpdate({ version: "1.1.29", releaseDate: "2026-11-19T00:00:00.000Z" }, "1.1.28");
  assert.equal(decision.serverVersion, "1.1.29");
  assert.equal(decision.updateAvailable, true);
  assert.equal(decision.availableVersion, "1.1.29");
  assert.equal(decision.releaseDate, "2026-11-19T00:00:00.000Z");
});

test("开发模式检查后界面展示服务器最新版本，而不是显示不可用", () => {
  const view = presentUpdate(devState());
  assert.equal(view.latestVersionLabel, "v1.1.28");
  assert.equal(view.headline, "已是最新版本");
  assert.equal(view.tone, "idle");
  assert.doesNotMatch(view.summary, /无法在线更新/);
  assert.doesNotMatch(view.summary, /安装版/);
});

test("开发模式发现新版本时提示手动覆盖安装", () => {
  const view = presentUpdate(devState({
    status: "available",
    updateAvailable: true,
    availableVersion: "1.1.29",
    serverVersion: "1.1.29",
  }));
  assert.equal(view.primaryAction, "download");
  assert.equal(view.latestVersionLabel, "v1.1.29");
  assert.match(view.steps.join(""), /开发模式不会自动替换当前应用/);
});

test("打包版发现新版本时沿用自动安装步骤", () => {
  const view = presentUpdate(devState({
    canInstall: true,
    status: "available",
    updateAvailable: true,
    availableVersion: "1.1.29",
    serverVersion: "1.1.29",
  }));
  assert.equal(view.primaryAction, "download");
  assert.doesNotMatch(view.steps.join(""), /开发模式/);
});

test("平台不支持时仍然明确提示无法在线更新", () => {
  const view = presentUpdate(devState({ platform: "linux", supported: false, serverVersion: undefined }));
  assert.equal(view.headline, "当前平台无法在线更新");
  assert.equal(view.latestVersionLabel, "—");
});

test("诊断信息区分「可检查」与「可自动安装」，并带上服务器版本", () => {
  const text = diagnosticText(devState());
  assert.match(text, /支持在线更新：是/);
  assert.match(text, /可自动安装：否（开发模式需手动安装）/);
  assert.match(text, /服务器最新版本：v1\.1\.28/);
});
