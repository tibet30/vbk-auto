/**
 * 托管渠道地址固定：MiniMax 必须走服务端网关，不能被本机残留的直连地址覆盖。
 *
 * 背景：升级到网关后，老机器 SQLite 里仍存着 api.minimaxi.com/v1；若继续读该设置，
 * 客户端会带着登录令牌打到上游并稳定 401，而本地订阅 Key 已被清除，AI 直接不可用。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

test("MiniMax 服务地址固定为网关常量，不读本机旧设置", () => {
  const runtime = read("src/main/main-runtime.ts");
  assert.match(runtime, /export const AI_GATEWAY_BASE_URL = "https:\/\/www\.atdtour\.com\/api\/ai\/gateway\/v1"/);
  assert.match(runtime, /minimaxBaseUrl: AI_GATEWAY_BASE_URL/);
  assert.doesNotMatch(runtime, /minimaxBaseUrl:\s*db\.getSetting/);
});

test("网关令牌不再与本机 Key 混用", () => {
  const runtime = read("src/main/main-runtime.ts");
  assert.match(runtime, /if \(provider === "minimax"\) return gatewayToken\(\)/);
  assert.match(runtime, /hasMiniMaxKey: Boolean\(gatewayToken\(\)\)/);
});

test("设置页不再暴露 AI 模型配置区块", () => {
  const page = read("src/renderer/app/views/settings/index.tsx");
  assert.doesNotMatch(page, /AiProviderBlock/);
  assert.doesNotMatch(page, /minimax-block/);
});
