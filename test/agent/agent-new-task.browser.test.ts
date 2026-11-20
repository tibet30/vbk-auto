// 浏览器回归：新建任务必须回到首页输入框，且不得凭空创建任务。
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const HOME_TITLE = "今天想完成什么？";
const SHORT = { timeout: 5000 };

test("每次点新建任务都回到首页输入框，不新建空白任务", async () => {
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-workspace-ui/index.html`);
    await page.getByRole("heading", { name: HOME_TITLE }).waitFor(SHORT);

    const newTask = page.getByRole("button", { name: "新建任务", exact: true });
    const composer = page.getByRole("textbox", { name: "新任务内容" });

    await page.getByRole("button", { name: /查我的订单/ }).first().click();
    await page.getByRole("heading", { name: "查我的订单" }).waitFor(SHORT);

    await newTask.click();
    await page.getByRole("heading", { name: HOME_TITLE }).waitFor(SHORT);
    assert.equal(await composer.inputValue(), "");
    assert.equal(await page.evaluate(() => (window as any).__fx.counters.create), 0, "新建任务不应落库空白任务");
    assert.deepEqual(await page.evaluate(() => (window as any).__fx.titles()), ["查我的订单"]);

    await composer.fill("先写一半的草稿");
    await newTask.click();
    await page.getByRole("heading", { name: HOME_TITLE }).waitFor(SHORT);
    assert.equal(await page.getByRole("textbox", { name: "新任务内容" }).inputValue(), "", "再点新建任务应给出空白输入框");
    assert.equal(await page.evaluate(() => (window as any).__fx.counters.create), 0);

    await page.evaluate(() => (window as any).__fx.holdSend());
    await page.getByRole("textbox", { name: "新任务内容" }).fill("整理一下今天的订单");
    await page.getByRole("button", { name: "开始任务" }).click();
    await page.getByPlaceholder("继续补充要求…").waitFor(SHORT);
    await newTask.click();
    await page.getByRole("heading", { name: HOME_TITLE }).waitFor(SHORT);

    await page.evaluate(() => (window as any).__fx.releaseSend());
    await page.getByRole("button", { name: /整理一下今天的订单/ }).first().waitFor(SHORT);
    assert.equal(await page.getByRole("heading", { name: HOME_TITLE }).isVisible(), true, "在途任务结束后不得把用户拽回对话");
    assert.equal(await page.evaluate(() => (window as any).__fx.counters.create), 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "/tmp/vbk-agent-new-task-home.png" });
  } finally {
    await browser.close();
    await server.close();
  }
});
