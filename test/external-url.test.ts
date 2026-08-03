import test from "node:test";
import assert from "node:assert/strict";
import { openExternalUrl } from "../src/main/external-url.js";

test("使用系统默认浏览器打开当前内嵌页面地址", async () => {
  const opened: string[] = [];

  await openExternalUrl("https://vbooking.ctrip.com/product/detail?id=76476655", async (url) => {
    opened.push(url);
  });

  assert.deepEqual(opened, ["https://vbooking.ctrip.com/product/detail?id=76476655"]);
});

test("拒绝向系统浏览器传递非 HTTP(S) 地址", async () => {
  let called = false;

  await assert.rejects(
    openExternalUrl("javascript:alert(1)", async () => { called = true; }),
    /仅支持打开 HTTP 或 HTTPS 页面/,
  );
  assert.equal(called, false);
});

test("拒绝打开空的内嵌页面地址", async () => {
  await assert.rejects(openExternalUrl("", async () => {}), /当前页面没有可打开的地址/);
});
