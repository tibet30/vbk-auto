import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("授权子产品默认未勾选，勾选值传入授权；第二页手动按钮独立触发补录", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const generate of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-ui/index.html`);
      await page.getByRole("button", { name: "轻松一些", exact: true }).click();
      await page.getByRole("textbox", { name: "请补充你希望保留的文案" }).fill("慢慢旅行");
      await page.getByRole("button", { name: "提交回答并继续" }).click();
      const checkbox = page.getByRole("checkbox", { name: /是否生成子产品/ });
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await page.getByRole("checkbox", { name: /同时授权玩法线路/ }).count(), 0);
      if (generate) {
        await checkbox.check();
        assert.equal(await page.getByRole("checkbox", { name: /同时授权玩法线路/ }).isChecked(), true);
      }
      await page.getByRole("button", { name: "确认方案并录入 VBK" }).click();
      await page.getByText("已进入 VBK 录入", { exact: true }).waitFor();
      const response = await page.evaluate(() => (window as any).agentFixture.lastApproval);
      assert.equal(response.generateTrafficChildren, generate);
      const create = page.getByRole("button", { name: "创建并录入子产品", exact: true });
      assert.equal(await create.isEnabled(), true);
      const review = page.getByRole("checkbox", { name: "同时授权玩法线路匹配审核", exact: true });
      assert.equal(await review.isChecked(), false);
      await page.screenshot({ path: `/tmp/vbk-traffic-children-${generate}.png`, fullPage: true });
      await create.click();
      await page.getByText("已授权子产品录入，请查看下方进度。", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.childRequest), { id: "fixture", routeReview: false });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
