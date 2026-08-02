import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import {
  selectCtripLibraryImage,
  type LibraryImageParams,
} from "../src/main/automation/ctrip.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = `file://${path.join(HERE, "library-image-fixture.html")}`;

async function boot(scenario: "happy" | "empty" | "no-poi") {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${FIXTURE}#${scenario}`);
  return { browser, ctx, page };
}

async function baseParams(page: any): Promise<LibraryImageParams> {
  return {
    trigger: page.locator("#trigger-card"),
    poi: "晋祠博物馆",
    minQuality: 3,
    aspect: "landscape",
    label: "封面",
  };
}

test("selectCtripLibraryImage happy: 选中并触发弹窗关闭", async () => {
  const { browser, page } = await boot("happy");
  try {
    const result = await selectCtripLibraryImage(page, await baseParams(page));
    assert.equal(result.reused, false);
    assert.equal(await page.locator(".dialog-mask.open").count(), 0);
    assert.equal(await page.evaluate(() => window.__selectedIndex), 2);
  } finally {
    await browser.close();
  }
});

test("selectCtripLibraryImage 0 张匹配图抛错并不自动选", async () => {
  const { browser, page } = await boot("empty");
  try {
    await assert.rejects(
      async () => selectCtripLibraryImage(page, await baseParams(page)),
      /未找到符合质量要求的图片/,
    );
    assert.equal(await page.evaluate(() => window.__selectedIndex), undefined);
  } finally {
    await browser.close();
  }
});

test("selectCtripLibraryImage POI 不存在抛错", async () => {
  const { browser, page } = await boot("no-poi");
  try {
    await assert.rejects(
      async () => selectCtripLibraryImage(page, await baseParams(page)),
      /未找到/,
    );
  } finally {
    await browser.close();
  }
});
