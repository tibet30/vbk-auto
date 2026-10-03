import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("真实产品列表轮询 SQLite 耗时，运行刷新、暂停冻结、历史缺失与窄屏均可读", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vbk-execution-ui-"));
  let now = Date.now();
  const db = new VbkDatabase(directory, () => now);
  const product = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
  const unknown = { ...product, id: "remote-only", name: "历史产品", executionTime: undefined };
  let queries = 0;
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
    name: "execution-telemetry-fixture",
    configureServer(viteServer) {
      viteServer.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/__executionTimes?")) return next();
        queries++;
        const ids = JSON.parse(new URL(request.url, "http://localhost").searchParams.get("ids")!) as string[];
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(db.getProductExecutionTimes(ids)));
      });
    },
  }], server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const end = db.executionClock.begin(product.id);
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/product-execution-ui/index.html`);
    await page.waitForFunction(() => "executionFixture" in window);
    await page.evaluate(products => (window as any).executionFixture.setProducts(products), [product, unknown]);
    await page.getByText("已消耗 0 秒", { exact: true }).waitFor();
    await page.getByText("已消耗 暂无记录", { exact: true }).waitFor();
    now += 2000;
    await page.getByText("已消耗 2 秒", { exact: true }).waitFor();
    db.executionClock.setEnabled(product.id, false, "agent");
    now += 60_000;
    const before = queries;
    await page.waitForFunction(() => document.body.textContent?.includes("已消耗 2 秒"));
    await page.waitForResponse(response => response.url().includes("/__executionTimes?"));
    assert.ok(queries > before);
    assert.equal(await page.getByText("已消耗 2 秒", { exact: true }).count(), 1);
    db.executionClock.setEnabled(product.id, true, "agent");
    now += 1000; end();
    await page.getByText("已消耗 3 秒", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByText("已消耗 3 秒", { exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    mkdirSync("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/product-execution-time-mobile.png", fullPage: true });
    await page.evaluate(() => (window as any).executionFixture.setProducts([]));
    await page.getByText("已消耗 3 秒", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("execution UI diagnostic", { queries, persisted: db.getProductExecutionTimes([product.id]), text: await browser?.contexts()[0]?.pages()[0]?.locator("body").innerText() });
    throw error;
  } finally {
    end();
    await browser?.close(); await server.close(); db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
