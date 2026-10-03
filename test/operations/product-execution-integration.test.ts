import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { AgentCore } from "../../src/main/agent/core.js";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { trackProductExecution } from "../../src/main/operations/product-execution-clock.js";
import { runAutomationExclusive } from "../../src/main/automation/automation.main/automation.main.execution.js";
import { completeWithRetries } from "../../src/main/agent/core-model.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "vbk-execution-"));
  let now = Date.now();
  const db = new VbkDatabase(directory, () => now);
  const product = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, db, product, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("真实数据库 facade 接入 Agent 计时、等待冻结以及产品详情与列表读回", async t => {
  const { db, product, advance } = fixture(t);
  assert.deepEqual(product.executionTime, { elapsedMs: 0, running: false, historicalIncomplete: false });
  const turns = [
    { toolCalls: [{ id: "read", name: "read", arguments: {} }] },
    { toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "note", label: "补充要求", kind: "text", required: true }] } }] },
    { toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["write"], summary: "授权" } }] },
  ];
  const core = new AgentCore({
    model: { complete: async () => { advance(1000); return turns.shift() ?? {}; } },
    tools: [{ name: "read", description: "read", parameters: {}, execute: async () => { advance(2000); return { content: "ok" }; } }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
  }, db);
  await core.send(product.id, "创建产品"); await core.idle(product.id);
  const waiting = await core.get(product.id);
  assert.equal(waiting.run?.status, "waiting_input");
  assert.equal(db.getProduct(product.id)!.executionTime!.elapsedMs, 4000);
  advance(60_000);
  await core.respond(product.id, { requestId: waiting.pendingInput!.id, answers: { note: "说明" } });
  await core.idle(product.id);
  assert.equal((await core.get(product.id)).run?.status, "waiting_approval");
  advance(60_000);
  const expected = { elapsedMs: 5000, running: false, historicalIncomplete: false };
  assert.deepEqual(db.getProductExecutionTimes([product.id, "unknown"]), { [product.id]: expected });
  assert.deepEqual(db.getProduct(product.id)!.executionTime, expected);
  assert.deepEqual(db.listProducts()[0].executionTime, expected);
  assert.deepEqual(db.listProductsPaginated(1).items[0].executionTime, expected);
});

test("远端重导入不能覆盖本地耗时，重启不把停机时间算入", async t => {
  const { db, directory, product, advance, now } = fixture(t);
  await trackProductExecution(product.id, async () => { advance(2000); });
  const imported = db.importProductSnapshot({ ...product, executionTime: { elapsedMs: 999999, running: true, historicalIncomplete: true } });
  assert.equal(imported.executionTime!.elapsedMs, 2000);
  assert.equal(JSON.stringify(imported.product).includes("executionTime"), false);
  db.close(); advance(3_600_000);
  const reopened = new VbkDatabase(directory, now);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getProductExecutionTimes([product.id])[product.id], {
    elapsedMs: 2000, running: false, historicalIncomplete: false,
  });
});

test("生产协调器的共享页面排队不计入外层工具耗时", async t => {
  const { db, product, advance } = fixture(t);
  const coordinator = new ProductWorkflowCoordinator();
  const other = db.createProduct({ destination: "成都", days: 1, productForm: "privateTour" });
  let release!: () => void;
  const first = coordinator.runQueuedAutomation(other.id, async () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const second = trackProductExecution(product.id, async () => {
    advance(1000);
    await coordinator.runQueuedAutomation(product.id, async () => { advance(2000); });
  });
  advance(60_000); release();
  await Promise.all([first, second]);
  assert.equal(db.getProductExecutionTimes([product.id])[product.id].elapsedMs, 3000);
});

test("自动录入互斥在停止后立即停表，迟到失败释放锁，重试继续累计", async t => {
  const { db, product, advance } = fixture(t);
  const args = { localProductId: product.id, clock: db.executionClock, running: new Set<string>(), cancellationRequested: new Set<string>() };
  let reject!: (error: Error) => void;
  const pending = runAutomationExclusive({ ...args, work: () => new Promise<void>((_resolve, fail) => { reject = fail; }) });
  await assert.rejects(runAutomationExclusive({ ...args, work: async () => {} }), /正在进行中/);
  advance(1000); db.executionClock.setEnabled(product.id, false, "automation");
  advance(60_000); reject(new Error("stopped")); await assert.rejects(pending, /stopped/);
  assert.equal(args.running.size, 0);
  await runAutomationExclusive({ ...args, work: async () => { advance(2000); } });
  assert.equal(db.getProductExecutionTimes([product.id])[product.id].elapsedMs, 3000);
  assert.equal(args.cancellationRequested.size, 0);
});

test("文本形式的供应商临时错误走有界重试，认证错误立即返回", async t => {
  const { db, product, advance } = fixture(t);
  let attempts = 0;
  await completeWithRetries({ complete: async () => {
    advance(1000);
    if (++attempts < 3) throw new Error("HTTP 503 provider_connection");
    return { content: "ok" };
  } }, { messages: [], tools: [] }, product.id);
  assert.equal(attempts, 3);
  assert.equal(db.getProductExecutionTimes([product.id])[product.id].elapsedMs, 3000);
  attempts = 0;
  await assert.rejects(completeWithRetries({ complete: async () => {
    attempts++; throw Object.assign(new Error("authentication failed"), { status: 401 });
  } }, { messages: [], tools: [] }, product.id), /authentication/);
  assert.equal(attempts, 1);
});
