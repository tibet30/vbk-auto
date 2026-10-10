import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("纯接送日显示接送餐食住宿说明，没有编号站点或景点分类控件", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 640 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/itinerary-support-ui/index.html`);
    await page.getByText("早餐含；正餐敬请自理。", { exact: true }).waitFor();
    assert.equal(await page.getByText(/第\s*\d+\s*站/).count(), 0);
    assert.equal(await page.getByText("尚无景点", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("combobox").count(), 0);
    assert.equal(await page.getByText("无需配置 POI", { exact: true }).count(), 0);
    assert.equal(await page.getByText("3 项活动", { exact: false }).count(), 0);
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/itinerary-support-wide.png", fullPage: true });
    const toggle = page.getByRole("button", { name: /汉中送机/ });
    await toggle.click();
    assert.equal(await page.getByText("早餐含；正餐敬请自理。", { exact: true }).count(), 0);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await page.getByText("早餐含；正餐敬请自理。", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "output/playwright/itinerary-support-narrow.png", fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
