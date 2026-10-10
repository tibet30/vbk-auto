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
  // Narrow scope — Settings interface itself must not expose apiKey field.
  // Other input types (AiConnectionTestInput, AiModelListInput) legitimately
  // accept apiKey for write/test flows; we only forbid it on the read shape.
  const settingsIfaceMatch = settingsBlock.match(/export interface Settings\s*\{([\s\S]*?)\n\}/);
  assert.ok(settingsIfaceMatch, "必须存在 Settings interface 定义");
  const settingsIface = settingsIfaceMatch![1];
  assert.doesNotMatch(settingsIface, /\bapiKey\s*:/);
  assert.doesNotMatch(settingsIface, /\bdeepseekApiKey\s*:/);

  // After splitting, getSettings() lives in main-runtime.ts.
  const getSettings = [
    read("src/main/main.ts"),
    read("src/main/main-runtime.ts"),
  ].join("\n");
  assert.match(getSettings, /hasMiniMaxKey:\s*input\.getAiKeyStore\(\)\?\.hasKey\(["']minimax["']\)\s*\?\?\s*false/);
  assert.match(getSettings, /hasDeepSeekKey:\s*input\.getAiKeyStore\(\)\?\.hasKey\(["']deepseek["']\)\s*\?\?\s*false/);
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
