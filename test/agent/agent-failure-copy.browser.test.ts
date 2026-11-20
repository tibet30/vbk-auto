// 浏览器回归：模型失败时错误条必须是中文说明 + 下一步，不许出现 IPC/SDK 英文原文。
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const SHORT = { timeout: 5000 };

async function openWorkspace() {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-workspace-ui/index.html`);
  await page.getByRole("button", { name: /查我的订单/ }).first().click();
  await page.getByPlaceholder("继续补充要求…").waitFor(SHORT);
  return {
    page,
    errors,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

test("模型空流的错误条给中文说明与「继续运行」下一步", async () => {
  const app = await openWorkspace();
  try {
    const raw = "Error invoking remote method 'agentWorkspace:send': Error: 模型这次没有返回任何内容，本次运行已暂停。";
    await app.page.evaluate((message) => (window as any).__fx.failNextSend(message), raw);
    const composer = app.page.getByPlaceholder("继续补充要求…");
    await composer.fill("整理今天的订单");
    await app.page.keyboard.press("Enter");

    const alert = app.page.getByRole("alert");
    await alert.waitFor(SHORT);
    const text = await alert.innerText();
    assert.match(text, /没有返回任何内容/u);
    assert.match(text, /继续运行/u, "提示里要说明下一步怎么做");
    assert.doesNotMatch(text, /Error invoking remote method|No output generated/u);
    await app.page.screenshot({ path: "/tmp/vbk-agent-failure-copy.png" });

    await app.page.getByRole("button", { name: "关闭提示" }).click();
    assert.equal(await alert.isVisible(), false, "错误条要能关掉");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("纯英文技术错误退回中文兜底，不把 SDK 原文塞给运营", async () => {
  const app = await openWorkspace();
  try {
    const raw = "Error invoking remote method 'agentWorkspace:send': AI_NoOutputGeneratedError: No output generated. Check the stream for errors.";
    await app.page.evaluate((message) => (window as any).__fx.failNextSend(message), raw);
    await app.page.getByPlaceholder("继续补充要求…").fill("整理今天的订单");
    await app.page.keyboard.press("Enter");

    const alert = app.page.getByRole("alert");
    await alert.waitFor(SHORT);
    const text = await alert.innerText();
    assert.match(text, /任务执行失败/u);
    assert.doesNotMatch(text, /NoOutputGenerated|No output generated|Check the stream|Error invoking/u);
  } finally {
    await app.close();
  }
});
