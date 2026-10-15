import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("行程审核边界只在异常态给只读核查入口，不展示二次审核提交", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/itinerary-review-unlock-ui/index.html`);
    const check = page.getByRole("button", { name: "检查标签状态", exact: true });

    // 正常态：只保留一行解锁范围说明，不渲染卡片、也不给核查入口。
    await page.waitForFunction(() => document.body.innerText.includes("已解锁 10/10 个页签"));
    assert.equal(await check.count(), 0);
    assert.ok(await page.evaluate(() => (window as any).unlockFixtureCalls.local) > 0);
    assert.equal(await page.evaluate(() => (window as any).unlockFixtureCalls.refresh), 0);
    assert.equal(await page.locator("dialog").count(), 0);
    assert.equal(await page.getByRole("button", { name: /审核.*解锁|确认审核/ }).count(), 0);
    assert.equal(await page.evaluate(() => typeof (window as any).vbk.automation.prepareItineraryReviewUnlock), "undefined");
    assert.equal(await page.evaluate(() => typeof (window as any).vbk.automation.executeItineraryReviewUnlock), "undefined");

    // 异常态：才出现单行核查入口，并且只读（不暴露提交能力）。
    await page.getByRole("button", { name: "结果不确定", exact: true }).click();
    await check.waitFor();
    await check.click();
    await page.waitForFunction(() => document.body.innerText.includes("只能只读核查"));
    assert.equal(await page.getByText("审核摘要不一致（已脱敏）", { exact: true }).count(), 1);
    assert.equal(await page.getByText("$.tourDailyDescriptions[0].tourDailyInfos[0].description", { exact: true }).count(), 1);
    assert.equal((await page.locator("body").innerText()).includes("保留行程正文"), false);

    await page.getByRole("button", { name: "延迟核查", exact: true }).click();
    await check.click();
    await page.getByRole("button", { name: "正在检查…", exact: true }).waitFor();
    await page.getByRole("button", { name: "禁用入口", exact: true }).click();
    await page.evaluate(() => (window as any).releaseUnlockRefresh());
    await page.getByRole("button", { name: "启用入口", exact: true }).click();
    await check.waitFor();

    await check.click();
    await page.getByRole("button", { name: "正在检查…", exact: true }).waitFor();
    await page.getByRole("button", { name: "切换产品", exact: true }).click();
    await page.evaluate(() => (window as any).releaseUnlockRefresh());
    await page.getByLabel("当前产品").getByText("two").waitFor();
    await check.waitFor();

    await page.getByRole("button", { name: "结束延迟", exact: true }).click();
    await page.getByRole("button", { name: "审核失败", exact: true }).click();
    await check.click();
    await page.waitForFunction(() => document.body.innerText.includes("自动审核尚未完成"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
