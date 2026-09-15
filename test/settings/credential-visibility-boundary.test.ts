/**
 * 凭据可见性边界：renderer 只能看到 hasKey / 账号摘要，不能读回明文 key 或 cookie。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

test("Settings 对外只有 hasKey 布尔，不含 apiKey 明文字段", () => {
  const settingsBlock = read("src/shared/contracts-settings.ts");
  assert.match(read("src/shared/contracts-types.ts"), /export \* from "\.\/contracts-settings\.js"/);
  assert.match(settingsBlock, /hasMiniMaxKey:\s*boolean/);
  assert.match(settingsBlock, /hasDeepSeekKey:\s*boolean/);
  assert.doesNotMatch(settingsBlock, /\bapiKey\s*:/);
  assert.doesNotMatch(settingsBlock, /\bdeepseekApiKey\s*:/);

  const getSettings = read("src/main/main.ts");
  assert.match(getSettings, /hasMiniMaxKey:\s*aiKeyStore \? aiKeyStore\.hasKey\("minimax"\)/);
  assert.match(getSettings, /hasDeepSeekKey:\s*aiKeyStore \? aiKeyStore\.hasKey\("deepseek"\)/);
  assert.doesNotMatch(getSettings, /hasMiniMaxKey:[\s\S]{0,400}apiKey:/);
});

test("settings:getApiKey 必须拒绝读回，不能把明文 key 返回 renderer", () => {
  const source = read("src/main/ipc/settings-ipc.ts");
  assert.match(source, /ipcMain\.handle\("settings:getApiKey"/);
  assert.match(source, /API Key 不可从 renderer 读回/);
});

test("VBK 登录状态与账号列表不含 cookie 值", () => {
  const contracts = read("src/shared/contracts-vbk-account.ts");
  assert.match(read("src/shared/contracts-types.ts"), /export \* from "\.\/contracts-vbk-account\.js"/);
  const loginStart = contracts.indexOf("export interface VbkLoginStatus {");
  const loginBlock = contracts.slice(loginStart, contracts.indexOf("}", loginStart) + 1);
  assert.match(loginBlock, /loggedIn:\s*boolean/);
  assert.match(loginBlock, /accountName\?:/);
  assert.match(loginBlock, /loginAccount\?:/);
  assert.doesNotMatch(loginBlock, /cookie/i);

  const savedStart = contracts.indexOf("export interface SavedLoginAccount {");
  const savedBlock = contracts.slice(savedStart, contracts.indexOf("}", savedStart) + 1);
  assert.match(savedBlock, /accountKey:\s*string/);
  assert.doesNotMatch(savedBlock, /cookiesJson|cookieValue|cookies\s*:/);
});
