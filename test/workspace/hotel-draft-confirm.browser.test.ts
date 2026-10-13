import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";

test("酒店草稿确认保持界面响应，取消不保存、确认只返回一次且不用原生确认框", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
    server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "hotel-dialog-fixture", configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== "/hotel-dialog-fixture") return next();
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<html><body><button id="start">重新执行酒店资源</button><script type="module">
          import {confirmHotelDraftRetry} from '/src/renderer/app/actions/workflow/hotel-draft-confirm.ts';
          window.confirm=()=>{throw new Error('禁止同步原生确认框')}; window.heartbeat=0; window.approved=0;
          setInterval(()=>window.heartbeat++,10);
          document.querySelector('#start').onclick=async()=>{window.result=await confirmHotelDraftRetry({
            token:'isolated',localProductId:'local',productId:'100',accountKey:'vbk_test',stays:[{cityName:'广安',nights:1}]});
            if(window.result)window.approved++;
          };
        </script></body></html>`);
      });
    } }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}hotel-dialog-fixture`);
    await page.waitForFunction(() => (window as any).heartbeat > 1);
    const open = page.getByRole("button", { name: "重新执行酒店资源", exact: true });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "仅保存酒店规则草稿", exact: true });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /自动匹配：是.*三钻、四钻、五钻.*指定酒店：空/s);
    const heartbeat = await page.evaluate(() => (window as any).heartbeat);
    await page.waitForFunction(value => (window as any).heartbeat > value + 2, heartbeat);
    assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => (window as any).result), false);
    assert.equal(await page.evaluate(() => (window as any).approved), 0);
    assert.equal(await open.evaluate(node => node === document.activeElement), true);
    await open.click();
    await dialog.getByRole("button", { name: "仅保存酒店草稿", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => (window as any).approved), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
