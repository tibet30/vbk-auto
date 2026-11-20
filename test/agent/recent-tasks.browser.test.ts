// 浏览器回归：最近任务首屏 20 条，滚到底部继续加载，删除用紧邻删除按钮的行内二次确认。
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const SHORT = { timeout: 5000 };
const ROW = 'aside[aria-label="最近任务"] [class*="threadRow"]';
const SCROLL = '[class*="threadScroll"]';

test("最近任务默认 20 条、触底加载更多、删除走紧邻的行内确认且没有重命名入口", async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 620 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-workspace-ui/index.html?seed=30`);

    const rows = page.locator(ROW);
    await rows.first().waitFor(SHORT);
    assert.equal(await rows.count(), 20, "首屏最多只渲染 20 条");
    const loadMore = page.getByRole("button", { name: "加载更多" });
    assert.equal(await loadMore.count(), 1);

    const scroll = page.locator(SCROLL);
    for (let round = 0; round < 6; round += 1) {
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(150);
    }
    assert.equal(await rows.count(), 31, "触底后加载出剩余任务");
    assert.equal(await page.getByRole("button", { name: "加载更多" }).count(), 0);

    await rows.first().hover();
    assert.equal(await page.getByRole("button", { name: "重命名任务" }).count(), 0, "不再提供重命名入口");

    const before = await page.evaluate(() => (window as unknown as { __fx: { threadCount(): number } }).__fx.threadCount());
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    await rows.first().hover();
    await rows.first().getByRole("button", { name: "删除任务" }).click();
    const confirmGroup = rows.first().getByRole("alertdialog", { name: /确认删除任务/ });
    await confirmGroup.waitFor(SHORT);
    assert.deepEqual(dialogs, [], "删除确认必须行内完成，不得弹系统确认框把鼠标推到窗口中央");

    const rowBox = await rows.first().boundingBox();
    const confirmBox = await rows.first().getByRole("button", { name: "确认删除", exact: true }).boundingBox();
    assert.ok(rowBox && confirmBox, "确认删除按钮必须可见");
    const gapToRowEdge = rowBox.x + rowBox.width - (confirmBox.x + confirmBox.width);
    assert.ok(gapToRowEdge >= 0 && gapToRowEdge <= 12, `确认删除应落在原删除按钮槽位，距行右缘 ${gapToRowEdge}px`);
    assert.ok(confirmBox.x >= rowBox.x + rowBox.width / 2, "确认按钮必须在行内右侧，贴近删除按钮位置");

    await page.keyboard.press("Escape");
    assert.equal(await rows.first().getByRole("button", { name: "确认删除", exact: true }).count(), 0, "Esc 收起确认");
    assert.equal(await page.evaluate(() => (window as unknown as { __fx: { threadCount(): number } }).__fx.threadCount()), before, "Esc 不删除");

    await rows.first().hover();
    await rows.first().getByRole("button", { name: "删除任务" }).click();
    await rows.first().getByRole("button", { name: "确认删除", exact: true }).click();
    await page.waitForFunction((count) => (window as unknown as { __fx: { threadCount(): number } }).__fx.threadCount() === count, before - 1);
    await page.waitForTimeout(200);
    assert.equal(await rows.count(), 30, "删除后列表立刻少一条");
    assert.equal(await page.evaluate(() => (window as unknown as { __fx: { counters: { remove: number } } }).__fx.counters.remove), 1);
    assert.deepEqual(dialogs, [], "整段删除流程都不出现系统确认框");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
