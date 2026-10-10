import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("已保存母草稿的暂停原因来自未完成交通子产品，已核验或禁用后不残留旧错误", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-ui/index.html`);
    await page.waitForFunction(() => Boolean((window as any).agentFixture));
    const failureReason = "第1天的活动时间顺序混乱，时间需晚于前序活动";
    const child = { variant: "flightRoundTrip", verified: false, completedStages: ["childCreated"], failureReason };
    const render = async (enabled: boolean, verified: boolean, reason = failureReason) => {
      await page.evaluate(({ enabled, verified, child, reason }) => (window as any).agentFixture.setPausedProduct({
        status: "draft_saved", productId: "79471108",
        product: { basicInfo: { meetingCity: "西宁" }, operations: { trafficLine: { enabled, variants: ["flightRoundTrip"] } } },
        automation: { status: "succeeded", trafficLine: { children: [{ ...child, verified, failureReason: reason, completedStages: verified ? ["finalReadback"] : child.completedStages }] } },
      }), { enabled, verified, child, reason });
    };
    await render(true, false);
    const notice = page.getByRole("status", { name: "任务暂停原因" });
    await notice.getByText("交通套餐未完成", { exact: true }).waitFor();
    assert.equal(await notice.isVisible(), true);
    assert.match(await notice.innerText(), /母产品草稿已保存/);
    assert.match(await notice.innerText(), /第1天的活动时间顺序混乱/);
    assert.equal(await page.getByRole("button", { name: "继续执行", exact: true }).first().isEnabled(), true);
    await render(true, false, "");
    await notice.getByText("任务暂停原因", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert", { name: "交通套餐录入受阻" }).count(), 0);
    await render(true, true);
    await notice.getByText("任务暂停原因", { exact: true }).waitFor();
    assert.doesNotMatch(await notice.innerText(), /时间顺序混乱/);
    assert.equal(await page.getByRole("alert", { name: "交通套餐录入受阻" }).count(), 0);
    await render(false, false);
    assert.doesNotMatch(await notice.innerText(), /时间顺序混乱/);
    await render(true, false, "当前无可售资源");
    assert.doesNotMatch(await notice.innerText(), /交通套餐未完成/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
