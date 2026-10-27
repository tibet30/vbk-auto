import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("真实组件渲染：私家团输入提示和缺图警告在桌面、窄屏均可读", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/private-tour-feedback-ui/index.html`);
    await page.getByText(/建议补充：付费景点/).waitFor();
    await page.evaluate(() => { (window as typeof window & { ideaFixture?: { failNext: boolean } }).ideaFixture!.failNext = true; });
    await page.getByRole("button", { name: "AI 优化想法" }).click();
    await page.getByRole("alert").filter({ hasText: "AI 服务暂时不可用" }).waitFor();
    await page.getByRole("button", { name: "重试" }).click();
    await page.getByRole("textbox", { name: "AI 版本" }).waitFor();
    assert.ok(await page.getByText("已保留", { exact: true }).isVisible());
    assert.ok(await page.getByText(/晋祠门票是否包含需要确认/).isVisible());
    assert.equal(await page.getByRole("textbox", { name: "AI 版本" }).isEditable(), false);
    await page.getByRole("button", { name: "使用 AI 版本" }).click();
    const adopted = await page.evaluate(() => (window as typeof window & { ideaInput?: { userIdea?: string; ideaOptimization?: { originalIdea: string; optimizedIdea: string; finalIdea?: string } } }).ideaInput);
    assert.match(adopted?.userIdea ?? "", /产品方向：太原亲子文化慢游/);
    assert.equal(adopted?.ideaOptimization?.originalIdea, "带孩子去晋祠，慢一点。");
    assert.equal(adopted?.ideaOptimization?.optimizedIdea, adopted?.userIdea);
    assert.equal(adopted?.ideaOptimization?.finalIdea, undefined);
    await page.getByLabel("天数").fill("3");
    await page.getByText(/输入已变化，请重新优化/).waitFor();
    assert.equal(await page.getByRole("button", { name: "使用 AI 版本" }).isDisabled(), true);
    assert.ok(await page.getByText(/待补景点图片：云冈石窟/).isVisible());
    mkdirSync("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/private-tour-feedback-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.ok(await page.getByText(/建议补充：付费景点/).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: "output/playwright/private-tour-feedback-narrow.png", fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
