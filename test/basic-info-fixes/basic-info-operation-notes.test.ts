import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  assertBasicInfoNoRedErrors,
} from "../../src/main/automation/ctrip/basic-info/core.js";

test("基本信息红错门禁覆盖操作说明非法关键词", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="ant-form-item ant-form-item-with-help">
        <div class="ant-form-item-label">操作说明</div>
        <div class="ant-form-explain">非法关键词：首发，请更换或删除非法关键词</div>
      </div>
    `);
    await assert.rejects(
      () => assertBasicInfoNoRedErrors(page),
      /基本信息仍有红色校验项：操作说明/,
    );
  } finally {
    await browser.close();
  }
});
