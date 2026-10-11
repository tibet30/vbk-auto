import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { manualReviewSavePolicy } from "../../src/main/operations/manual-review-save-policy.js";
import type { ManualReviewFieldInput } from "../../src/shared/contracts.js";

test("POI 行内取消不写入，失败可重试，确认删除实际持久化且不重复删除相邻站点", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vbk-removal-ui-"));
  const db = new VbkDatabase(directory);
  const readback = new VbkDatabase(directory);
  const mutations = new ProductMutationService(db);
  const seed = db.createProduct({ destination: "成都", days: 1, productForm: "privateTour" });
  db.updateProduct(seed.id, { ...seed.product, itinerary: [{ day: 1, title: "成都漫游", hotel: "无", meals: "自理", spots: [
    { name: "文殊院", kind: "attraction", poiName: null, poiId: null },
    { name: "人民公园", kind: "attraction", poiName: null, poiId: null },
  ] }] });
  let calls = 0;
  let fail = true;
  let release: (() => void) | undefined;
  let hold = false;
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
    name: "isolated-manual-removal",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url === "/__product") {
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(db.getProduct(seed.id))); return;
        }
        if (request.url !== "/__remove") return next();
        response.setHeader("Content-Type", "application/json");
        let body = "";
        for await (const part of request) body += part;
        const { id, input } = JSON.parse(body) as { id: string; input: ManualReviewFieldInput };
        calls++;
        if (hold) await new Promise<void>(resolve => { release = resolve; });
        try {
          if (fail) throw new Error("后台任务执行中，暂不能修改行程");
          assert.equal(id, seed.id);
          assert.deepEqual(input, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0 });
          const current = db.getProduct(id)!;
          const saved = mutations.commands.manualField({ localProductId: id, source: "user", expectedVersion: current.productJsonVersion ?? 0 },
            input, { status: manualReviewSavePolicy(current.status).nextStatus });
          response.end(JSON.stringify(saved));
        } catch (error) {
          response.statusCode = 409; response.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  }], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", async dialog => { errors.push(`unexpected native dialog: ${dialog.type()}`); await dialog.dismiss(); });
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/itinerary-removal-ui/index.html`);
    const remove = page.getByRole("button", { name: "删除 文殊院", exact: true });
    await remove.click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(calls, 0);
    await remove.click();
    await page.evaluate(async () => {
      const product = await (await fetch("/__product")).json();
      product.product.itinerary[0].spots.reverse();
      (window as any).removalFixture.setProduct(product);
    });
    await page.getByRole("status").getByText("行程已变化，请重新选择要删除的站点。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "确认删除", exact: true }).count(), 0);
    assert.equal(calls, 0);
    await page.evaluate(async () => (window as any).removalFixture.setProduct(await (await fetch("/__product")).json()));
    await page.evaluate(() => (window as any).removalFixture.disconnect());
    await remove.click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.getByRole("alert").getByText(/未连接桌面保存服务/).waitFor();
    assert.equal(calls, 0);
    await page.evaluate(() => (window as any).removalFixture.reconnect());
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.getByRole("alert").getByText("后台任务执行中，暂不能修改行程").waitFor();
    mkdirSync("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/poi-removal-inline-error.png", fullPage: true });
    assert.equal(calls, 1);
    assert.equal((readback.getProduct(seed.id)!.product.itinerary as any)[0].spots.length, 2);
    fail = false; hold = true;
    await page.getByRole("button", { name: "确认删除", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await page.getByRole("button", { name: "删除中…", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "取消", exact: true }).isDisabled(), true);
    // Wait for the held request before releasing the production save.
    const started = Date.now();
    while (!release && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release); release();
    await page.getByRole("status").getByText("已删除「文殊院」。", { exact: true }).waitFor();
    assert.equal(await remove.count(), 0);
    assert.equal(await page.getByRole("button", { name: "删除 人民公园", exact: true }).count(), 1);
    assert.equal(calls, 2);
    const persisted = readback.getProduct(seed.id)!.product as any;
    assert.deepEqual(persisted.itinerary[0].spots.map((spot: any) => spot.name), ["人民公园"]);
    assert.equal(persisted.manualReview.itinerarySpotRemovals[0].name, "文殊院");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    release?.(); await browser.close(); await server.close(); readback.close(); db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
