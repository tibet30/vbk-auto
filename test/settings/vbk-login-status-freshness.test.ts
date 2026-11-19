import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/renderer/app/state/derived.ts", import.meta.url),
  "utf8",
);

test("启动就绪与兜底核验都强制刷新 VBK 登录态", () => {
  const pageReady = source.slice(
    source.indexOf("const unsubscribePageReady"),
    source.indexOf("// 兜底："),
  );
  const retry = source.slice(
    source.indexOf("const retryLoginCheck"),
    source.indexOf("const unsubscribeCollections"),
  );

  assert.match(
    pageReady,
    /checkVbkLogin\(true\)/,
    "VBK 初始化完成后必须绕过旧用户缓存重新核验，不能让首次红态长期残留。",
  );
  assert.match(
    retry,
    /checkVbkLogin\(true\)/,
    "启动兜底必须等待初始化并强制核验，不能在浏览器仍准备中时写入永久红态。",
  );
});
