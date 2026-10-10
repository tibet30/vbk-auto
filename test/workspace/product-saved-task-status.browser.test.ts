import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import type { ProductSummary } from "../../src/shared/contracts.js";

test("已保存产品的列表主状态保持草稿已保存，未完成交通任务和继续入口仍可见", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/__executionTimes?*", route => route.fulfill({ json: {} }));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/product-execution-ui/index.html`);
    await page.waitForFunction(() => Boolean((window as any).executionFixture));
    const item: ProductSummary = { id: "saved-product", productId: "79471108", name: "西宁6天5晚私家团", status: "draft_saved", updatedAt: "2026-10-09T12:24:00Z",
      workflowTask: { id: "task", localProductId: "saved-product", productName: "西宁6天5晚私家团", status: "needs_attention", stage: "automation", progress: 91,
        message: "母产品草稿已保存；交通套餐尚未通过最终回读，继续交通阶段", createdAt: "2026-10-09T09:39:00Z", updatedAt: "2026-10-09T12:24:00Z" } };
    const render = async (product: ProductSummary) => {
      await page.evaluate(product => (window as any).executionFixture.setProducts([product]), product);
    };
    await render(item);
    await page.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByText("任务待处理", { exact: true }).count(), 0);
    assert.equal(await page.getByText(item.workflowTask!.message, { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("progressbar", { name: "母产品草稿保存进度" }).getAttribute("aria-valuenow"), "100");
    assert.equal(await page.getByRole("button", { name: `从报错处继续执行：${item.name}` }).isEnabled(), true);
    assert.equal(await page.getByRole("progressbar").evaluate(el => el.parentElement?.dataset.status), "succeeded");
    assert.equal(await page.getByRole("progressbar").locator("span").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(22, 163, 74)");
    for (const status of ["queued", "running", "failed"] as const) {
      await render({ ...item, workflowTask: { ...item.workflowTask!, status } });
      assert.equal(await page.getByText("草稿已保存", { exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "100");
    }
    await render({ ...item, coverNeedsReplacement: true });
    await page.getByText("草稿已存 · 需换图", { exact: true }).waitFor();
    await render({ ...item, status: "planning", productId: undefined });
    await page.getByText("任务待处理", { exact: true }).waitFor();
    assert.equal(await page.getByText("草稿已保存", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("progressbar", { name: "后台任务进度" }).getAttribute("aria-valuenow"), "91");
    await render({ ...item, status: "planning", productId: undefined, workflowTask: { ...item.workflowTask!, status: "succeeded" } });
    await page.getByText("方案规划中", { exact: true }).waitFor();
    assert.equal(await page.getByText("草稿已保存", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
