import test from "node:test";
import assert from "node:assert/strict";
import {
  findRowByTitle,
  setEnabledSelectByLabel,
  waitForRowSelectedLabel,
} from "../../src/main/automation/ctrip/sale-control/sale-control.controls.ts";

test("findRowByTitle 精确匹配标题，容忍空白和末尾必填星号", () => {
  let titleOptions: { hasText?: RegExp } | undefined;
  const legacyRow = { or: () => ({ first: () => "first-row" }) };
  const rows = { filter: () => ({ first: () => legacyRow }) };
  const modernRows = { filter: () => ({ first: () => ({}) }) };
  const page = {
    locator(selector: string, options?: { hasText?: RegExp }) {
      if (selector === ".saleControl-title") titleOptions = options;
      if (selector === ".saleControl-body .ant-row") return rows;
      if (selector === ".ant-form-item") return modernRows;
      return {};
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

test("waitForRowSelectedLabel 通过下拉回显确认目标值", async () => {
  const row = {
    locator(selector: string) {
      assert.equal(selector, ".ant-select-selection-selected-value, .ant-select-selection-item");
      return {
        count: async () => 1,
        nth: () => ({
          getAttribute: async (name: string) => (name === "title" ? "境内短途旅游" : ""),
          innerText: async () => "",
        }),
      };
    },
  };

  assert.equal(await waitForRowSelectedLabel(row, "境内短途旅游", 1), true);
  assert.equal(await waitForRowSelectedLabel(row, "境内长途旅游", 1), false);
});

test("setEnabledSelectByLabel 选项点击后等待行内回显再返回 selected", async () => {
  let optionClicked = false;
  const events: string[] = [];
  const row = {
    locator(selector: string) {
      if (selector === ".ant-select.ant-select-enabled") {
        return {
          first: () => ({
            count: async () => 1,
            scrollIntoViewIfNeeded: async () => events.push("scroll"),
            click: async () => events.push("open"),
          }),
        };
      }
      if (selector === ".ant-select-selection-selected-value, .ant-select-selection-item") {
        return {
          count: async () => (optionClicked ? 1 : 0),
          nth: () => ({
            getAttribute: async (name: string) => (name === "title" ? "境内短途旅游" : ""),
            innerText: async () => "",
          }),
        };
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
  };
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(role, "option");
      assert.deepEqual(options, { name: "境内短途旅游", exact: true });
      return {
        first: () => ({
          waitFor: async () => events.push("wait-option"),
          click: async () => {
            events.push("click-option");
            optionClicked = true;
          },
        }),
        count: async () => 1,
      };
    },
    keyboard: { press: async () => events.push("escape") },
  };

  const result = await setEnabledSelectByLabel(page, row, "境内短途旅游", "产品类型");

  assert.deepEqual(result, { selected: "境内短途旅游", description: "产品类型" });
  assert.deepEqual(events, ["scroll", "open", "wait-option", "click-option"]);
});
