import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  assertBasicInfoNoRedErrors,
  stripIllegalKeywords,
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

test("只删除 VBK 明确返回的非法关键词并清理重复分隔符", () => {
  assert.equal(
    stripIllegalKeywords("西湖游船+灵隐祈福+宋城", ["祈福"]),
    "西湖游船+灵隐+宋城",
  );
  assert.equal(
    stripIllegalKeywords("每日配额30份，最低起订人数1人；", ["最低"]),
    "每日配额30份，起订人数1人",
  );
});
