import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedVbkPageUrl, selectVbkPage } from "../../src/main/infrastructure/vbk-page-selection.js";

const page = (value: string) => ({ url: () => value });

test("页面选择优先当前有效的 VBK 页面", () => {
  const current = page("https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=1");
  const fallback = page("https://www.ctrip.com/");

  assert.equal(selectVbkPage([fallback, current], current.url()), current);
});

test("恢复时当前 view 为空白页，会跳过它并选择有效 VBK 页面", () => {
  const blank = page("");
  const renderer = page("http://127.0.0.1:5173/");
  const vbk = page("https://vbooking.ctrip.com/product/input/productListMerge?from=vbk");

  assert.equal(selectVbkPage([blank, renderer, vbk], ""), vbk);
});

test("当前 view 未导航时，回退优先已登录的 VBK 后台页", () => {
  const ctrip = page("https://www.ctrip.com/");
  const vbk = page("https://vbooking.ctrip.com/product/input/productListMerge?from=vbk");

  assert.equal(selectVbkPage([ctrip, vbk], "about:blank"), vbk);
});

test("非 HTTP(S) 或非 Ctrip 地址不能作为 VBK CDP 页面", () => {
  const candidates = [
    page("about:blank"),
    page("file:///tmp/a.html"),
    page("http://127.0.0.1:5173/"),
    page("https://not-ctrip.com/"),
  ];

  assert.equal(isAllowedVbkPageUrl(""), false);
  assert.equal(isAllowedVbkPageUrl("about:blank"), false);
  assert.equal(isAllowedVbkPageUrl("https://not-ctrip.com/"), false);
  assert.equal(selectVbkPage(candidates, "http://127.0.0.1:5173/"), undefined);
});
