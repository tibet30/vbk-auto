import test from "node:test";
import assert from "node:assert/strict";
import { findRowByTitle } from "../../src/main/automation/ctrip/sale-control/sale-control.controls.ts";

test("findRowByTitle 精确匹配标题，容忍空白和末尾必填星号", () => {
  let titleOptions: { hasText?: RegExp } | undefined;
  const result = { first: () => "first-row" };
  const rows = { filter: () => result };
  const page = {
    locator(selector: string, options?: { hasText?: RegExp }) {
      if (selector === ".saleControl-title") titleOptions = options;
      return selector === ".saleControl-body .ant-row" ? rows : {};
    },
  };

  assert.equal(findRowByTitle(page, "产品(常规)+"), "first-row");
  const pattern = titleOptions?.hasText;
  assert.ok(pattern instanceof RegExp, "应向 Playwright 传入合法正则");
  assert.match("  产品(常规)+ *  ", pattern);
  assert.match("产品(常规)+", pattern);
  assert.doesNotMatch("产品X常规+", pattern);
  assert.doesNotMatch("产品(常规)+ **", pattern);
});
