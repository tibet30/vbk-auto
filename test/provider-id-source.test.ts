import test from "node:test";
import assert from "node:assert/strict";
import { collectProviderIdCandidates } from "../src/main/provider-id-source.js";

function noMatch(reason: string) { return { href: "https://vbooking.ctrip.com/foo", cookies: "", scriptTexts: [], globals: {} }; }

test("URL 上的 providerId 优先级最高", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?providerId=1279416",
    cookies: "",
    scriptTexts: [],
    globals: {},
  });
  assert.equal(result.picked?.value, 1279416);
  assert.equal(result.picked?.key, "url.providerId");
});

test("URL 命中后，window 和 cookie 里其它候选都不影响结果", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x?providerId=1279416",
    cookies: "vbk-provider-id=9999999",
    scriptTexts: [],
    globals: { providerId: 8888888 },
  });
  assert.equal(result.picked?.value, 1279416);
  assert.equal(result.picked?.key, "url.providerId");
});

test("window.providerId 字符串形式也能识别", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x",
    cookies: "",
    scriptTexts: [],
    globals: { providerId: "1279416" },
  });
  assert.equal(result.picked?.value, 1279416);
  assert.equal(result.picked?.key, "window.providerId");
});

test("window 上的非数字字符串不会污染结果", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x",
    cookies: "",
    scriptTexts: [],
    globals: { providerId: "abc", userInfo: { providerId: 123 } },
  });
  assert.equal(result.picked?.value, 123);
  assert.equal(result.picked?.key, "window.userInfo");
});

test("内嵌 JSON 里的 providerId 会被搜出来", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x",
    cookies: "",
    scriptTexts: [`window.__INITIAL_STATE__=${JSON.stringify({ currentUser: { providerId: 1279416, name: "运营小王" } })};`],
    globals: {},
  });
  assert.equal(result.picked?.value, 1279416);
  assert.equal(result.picked?.key, "inline-json");
});

test("cookie 里的 vbk-provider-id 也能识别", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x",
    cookies: "vbk-provider-id=1279416; other=foo",
    scriptTexts: [],
    globals: {},
  });
  assert.equal(result.picked?.value, 1279416);
  assert.equal(result.picked?.key, "cookie.vbk-provider-id");
});

test("href 不是合法 URL 时不抛错，返回 null", () => {
  const result = collectProviderIdCandidates({ href: "not a url", cookies: "", scriptTexts: [], globals: {} });
  assert.equal(result.picked, null);
});

test("什么都没找到时返回 null", () => {
  const result = collectProviderIdCandidates(noMatch("empty"));
  assert.equal(result.picked, null);
  assert.deepEqual(result.candidates, []);
});

test("无效 JSON 脚本块被忽略，不抛错", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x",
    cookies: "",
    scriptTexts: ["{ this is not json }", "var x = 1;"],
    globals: {},
  });
  assert.equal(result.picked, null);
});

test("数值 ≤ 0 不会被当作 providerId", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x?providerId=0",
    cookies: "",
    scriptTexts: [],
    globals: {},
  });
  assert.equal(result.picked, null);
});

test("内嵌 JSON 里嵌套对象多于一层的 providerId 也能找到", () => {
  const result = collectProviderIdCandidates({
    href: "https://vbooking.ctrip.com/x",
    cookies: "",
    scriptTexts: [`var data = ${JSON.stringify({ a: { b: { c: { providerId: 42, d: { vendorId: 1279416 } } } } })};`],
    globals: {},
  });
  // vendorId 也会被 toProviderId 识别为数字，但 vendorId 不在 URL/window/cookie 候选里；
  // 当前 inline-json 只取第一个出现，因此 42 会被先命中。
  assert.equal(result.picked?.value, 42);
});