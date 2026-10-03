import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runDatabaseMigrations } from "../../src/main/infrastructure/database/parts/migration-registry.js";
import { ProductExecutionClock, setProductExecutionClock, waitWithoutExecutionTime } from "../../src/main/operations/product-execution-clock.js";
import { historicalExecutionTime } from "../../src/main/operations/product-execution-history.js";
import { completeWithRetries } from "../../src/main/agent/core-model.js";
import { AgentCore } from "../../src/main/agent/core.js";
import { getAgentSnapshot, saveAgentSnapshot } from "../../src/main/infrastructure/database/parts/agent.js";
import { createProduct, getProduct, importProductSnapshot, listProducts, listProductsPaginated } from "../../src/main/infrastructure/database/parts/products.js";
import { formatProductExecutionTime } from "../../src/shared/product-execution-time.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { readProductExecutionTimes } from "../../src/main/operations/product-execution-time-read.js";

function fixture(t: test.TestContext) {
  const db = new Database(":memory:");
  runDatabaseMigrations(db);
  let now = Date.now();
  const clock = new ProductExecutionClock(db, () => now);
  t.after(() => { clock.dispose(); setProductExecutionClock(undefined); db.close(); });
  return { db, clock, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("a queued product counts only its own execution after the shared workflow is released", async (t) => {
  const { clock, advance } = fixture(t);
  // Simulate queue semantics: while second is waiting behind first (suspended
  // by an explicit waitWithoutExecutionTime), the suspension period must not
  // count toward second's elapsed time. Once second's actual work runs, only
  // that work should be recorded.
  let release!: () => void;
  const first = clock.track("first", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
  });
  const second = clock.track("second", async () => {
    await waitWithoutExecutionTime(async () => {
      await new Promise<void>((resolve) => {
        // Released by the outer test code below; acts as a queue signal.
        const tick = setInterval(() => {
          if (releaseRef.resolved) {
            clearInterval(tick);
            resolve();
          }
        }, 1);
      });
    });
    advance(1200);
  });
  const releaseRef = { resolved: false };
  const originalRelease = release;
  release = () => { releaseRef.resolved = true; originalRelease(); };
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(clock.read("first").running, true);
  assert.equal(clock.read("second").running, false);
  assert.equal(clock.read("second").elapsedMs, 0);
  advance(60_000);
  release();
  await Promise.all([first, second]);
  assert.equal(clock.read("second").elapsedMs, 1200);
});

test("counts the union of parallel calls, freezes while paused, and accumulates after resume", (t) => {
  const { clock, advance } = fixture(t);
  const endAi = clock.begin("product");
  advance(1000);
  const endTool = clock.begin("product");
  advance(1000);
  clock.setEnabled("product", false);
  assert.equal(clock.read("product").elapsedMs, 2000);
  advance(60_000);
  assert.equal(clock.read("product").elapsedMs, 2000);
  assert.equal(clock.read("product").running, false);
  clock.setEnabled("product", true);
  advance(1000); endAi();
  advance(1000); endTool(); endTool();
  advance(60_000);
  assert.deepEqual(clock.read("product"), { elapsedMs: 4000, running: false, historicalIncomplete: false });
});

test("nested calls exclude queue time without stopping an independent parallel call", async (t) => {
  const { clock, advance } = fixture(t);
  let endParallel: (() => void) | undefined;
  await clock.track("p", async () => {
    advance(1000);
    await clock.track("p", async () => {
      await waitWithoutExecutionTime(async () => { advance(60_000); });
      advance(1000);
      await waitWithoutExecutionTime(async () => {
        endParallel = clock.begin("p");
        advance(2000); endParallel();
        advance(60_000);
      });
    });
  });
  assert.equal(clock.read("p").elapsedMs, 4000);
});

test("a rejected function releases its interval and does not keep counting", async (t) => {
  const { clock, advance } = fixture(t);
  await assert.rejects(clock.track("p", async () => { advance(1200); throw new Error("failed"); }), /failed/);
  advance(60_000);
  assert.equal(clock.read("p").elapsedMs, 1200);
  assert.equal(clock.read("p").running, false);
});

test("late results after stopping cannot reopen the clock; independent pause gates must both resume", async (t) => {
  const { clock, advance } = fixture(t);
  let resolve!: () => void;
  const pending = clock.track("p", () => new Promise<void>((done) => { resolve = done; }));
  advance(1000);
  clock.setEnabled("p", false, "automation");
  clock.setEnabled("p", false, "agent");
  advance(60_000);
  clock.setEnabled("p", true, "agent");
  assert.equal(clock.read("p").running, false);
  resolve(); await pending;
  assert.equal(clock.read("p").elapsedMs, 1000);
  clock.setEnabled("p", true, "automation");
  const end = clock.begin("p"); advance(1000); end();
  assert.equal(clock.read("p").elapsedMs, 2000);
});

test("restart preserves checkpoints and excludes downtime; crash loss is bounded", (t) => {
  const { db, clock, advance, now } = fixture(t);
  clock.begin("p"); advance(5000); clock.checkpoint();
  const persisted = db.prepare("SELECT * FROM product_execution_time WHERE local_product_id='p'").get() as { elapsed_ms: number; active_since: number };
  advance(500);
  assert.equal(clock.read("p").elapsedMs, 5500);
  clock.dispose();
  // Restore exactly the durable checkpoint that would survive an abrupt exit.
  db.prepare("UPDATE product_execution_time SET elapsed_ms=?,active_since=? WHERE local_product_id='p'")
    .run(persisted.elapsed_ms, persisted.active_since);
  advance(3_600_000);
  const recovered = new ProductExecutionClock(db, now);
  assert.equal(recovered.read("p").elapsedMs, 5000);
  assert.equal(recovered.read("p").running, false);
  const end = recovered.begin("p"); advance(1000); end();
  assert.equal(recovered.read("p").elapsedMs, 6000);
  recovered.dispose();
});

test("AI transport retries count failed attempts as well as the successful call", async (t) => {
  const { clock, advance } = fixture(t);
  setProductExecutionClock(clock);
  let attempts = 0;
  await completeWithRetries({ complete: async () => {
    advance(1000);
    if (++attempts < 3) throw Object.assign(new Error("provider_connection"), { status: 503 });
    return { content: "ok" };
  } }, { messages: [], tools: [] }, "p");
  assert.equal(clock.read("p").elapsedMs, 3000);
  assert.equal(clock.read("p").running, false);
});

test("real Agent AI and tool flow uses the clock; waiting for user and approval does not", async (t) => {
  const { db, clock, advance } = fixture(t);
  setProductExecutionClock(clock);
  const turns = [
    { toolCalls: [{ id: "read", name: "read", arguments: {} }] },
    { toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "note", label: "补充要求", kind: "text", required: true }] } }] },
    { toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["write"], summary: "授权" } }] },
  ];
  const core = new AgentCore({
    model: { complete: async () => { advance(1000); return turns.shift() ?? {}; } },
    tools: [{ name: "read", description: "read", parameters: {}, execute: async () => { advance(2000); return { content: "ok" }; } }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
  }, {
    getAgentSnapshot: (id) => getAgentSnapshot(db, id),
    saveAgentSnapshot: (snapshot) => {
      saveAgentSnapshot(db, snapshot);
      if (snapshot.run) clock.setEnabled(snapshot.localProductId, snapshot.run.status === "running");
    },
  });
  await core.send("p", "创建产品"); await core.idle("p");
  const waiting = await core.get("p");
  assert.equal(waiting.run?.status, "waiting_input");
  assert.equal(clock.read("p").elapsedMs, 4000);
  advance(60_000);
  await core.respond("p", { requestId: waiting.pendingInput!.id, answers: { note: "说明" } });
  await core.idle("p");
  assert.equal((await core.get("p")).run?.status, "waiting_approval");
  assert.equal(clock.read("p").elapsedMs, 5000);
  advance(60_000);
  assert.equal(clock.read("p").elapsedMs, 5000);
});

test("detail, list, pagination and remote reimport read the same persisted telemetry", (t) => {
  const { db, clock, advance } = fixture(t);
  const product = createProduct(db, { destination: "成都", days: 3, productForm: "privateTour" });
  const end = clock.begin(product.id); advance(2000); end();
  const before = getProduct(db, product.id)!;
  assert.deepEqual(before.executionTime, { elapsedMs: 2000, running: false, historicalIncomplete: false });
  importProductSnapshot(db, { ...product, executionTime: { elapsedMs: 999999, running: true, historicalIncomplete: true } });
  assert.deepEqual(getProduct(db, product.id)!.executionTime, before.executionTime);
  assert.deepEqual(listProducts(db)[0].executionTime, before.executionTime);
  assert.deepEqual(listProductsPaginated(db, 1).items[0].executionTime, before.executionTime);
  assert.equal(JSON.stringify(getProduct(db, product.id)!.product).includes("executionTime"), false);
});

test("product lists batch clock reads and persist a legacy reconstruction", (t) => {
  const statements: string[] = [];
  const db = new Database(":memory:", { verbose: (statement) => statements.push(statement) });
  runDatabaseMigrations(db);
  t.after(() => db.close());
  const products = [1, 2, 3].map(() => createProduct(db, { destination: "成都", days: 3, productForm: "privateTour" }));
  statements.length = 0;
  assert.equal(listProducts(db).length, products.length);
  assert.equal(clockBatchReads(statements), 1);
  statements.length = 0;
  assert.equal(listProductsPaginated(db, 1, products.length).items.length, products.length);
  assert.equal(clockBatchReads(statements), 1);

  const legacy = products[0];
  db.prepare("DELETE FROM product_execution_time WHERE local_product_id=?").run(legacy.id);
  saveAgentSnapshot(db, {
    localProductId: legacy.id,
    events: [
      { id: "call", type: "tool_call", createdAt: "2026-10-02T00:00:00.000Z", content: "", data: { toolCallId: "call", name: "read" } },
      { id: "result", type: "tool_result", createdAt: "2026-10-02T00:00:02.000Z", content: "", data: { toolCallId: "call" } },
    ],
  });
  statements.length = 0;
  assert.equal(listProducts(db).find((product) => product.id === legacy.id)?.executionTime?.elapsedMs, 2000);
  assert.ok(historyReads(statements) > 0);
  assert.ok(db.prepare("SELECT 1 FROM product_execution_time WHERE local_product_id=?").get(legacy.id));
  statements.length = 0;
  assert.equal(listProducts(db).find((product) => product.id === legacy.id)?.executionTime?.elapsedMs, 2000);
  assert.equal(historyReads(statements), 0);
});

test("execution-time reads chunk more than 500 IDs and omit unknown products", (t) => {
  const statements: string[] = [];
  const db = new Database(":memory:", { verbose: (statement) => statements.push(statement) });
  runDatabaseMigrations(db);
  t.after(() => db.close());
  const products = Array.from({ length: 501 }, () => createProduct(db, { destination: "成都", days: 1, productForm: "privateTour" }));
  statements.length = 0;
  const times = readProductExecutionTimes(db, [...products.map((product) => product.id), "missing-product"]);
  assert.equal(Object.keys(times).length, 501);
  assert.equal(times["missing-product"], undefined);
  assert.equal(clockBatchReads(statements), 2);
});

function clockBatchReads(statements: readonly string[]): number {
  return statements.filter((statement) => statement.includes("LEFT JOIN product_execution_time AS clock")).length;
}

function historyReads(statements: readonly string[]): number {
  return statements.filter((statement) => /agent_snapshots|automation_runs|operation_log/.test(statement)).length;
}

test("legacy reconstruction excludes paused calls, human interactions and retry waits; no overlapping double count", (t) => {
  const { db } = fixture(t);
  const iso = (seconds: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, seconds)).toISOString();
  const events: AgentSnapshot["events"] = [];
  const event = (type: AgentSnapshot["events"][number]["type"], seconds: number, data: Record<string, unknown>) => {
    events.push({ id: `e${events.length}`, type, createdAt: iso(seconds), content: "", data });
  };
  event("status", 0, { status: "running" });
  event("tool_call", 0, { name: "read", toolCallId: "read" });
  event("status", 5, { status: "paused" });
  event("tool_result", 10, { toolCallId: "read" });
  event("status", 100, { status: "running" });
  event("status", 100, { aiUsage: { startedAt: iso(100), endedAt: iso(110) } });
  event("tool_call", 105, { name: "read", toolCallId: "parallel" });
  event("tool_result", 115, { toolCallId: "parallel" });
  event("tool_call", 116, { name: "ask_user", toolCallId: "ask" });
  event("tool_result", 176, { toolCallId: "ask" });
  event("tool_call", 180, { name: "read", toolCallId: "retry" });
  event("status", 181, { waitSeconds: 10 });
  event("tool_result", 192, { toolCallId: "retry" });
  saveAgentSnapshot(db, { localProductId: "legacy", events });
  assert.deepEqual(historicalExecutionTime(db, "legacy"), { elapsedMs: 22000, running: false, historicalIncomplete: true });
});

test("formats hours and unknown or partial legacy telemetry clearly", () => {
  assert.equal(formatProductExecutionTime(undefined), "暂无记录");
  assert.equal(formatProductExecutionTime({ elapsedMs: 3661000, running: false, historicalIncomplete: false }), "1 小时 1 分 1 秒");
  assert.equal(formatProductExecutionTime({ elapsedMs: 2000, running: false, historicalIncomplete: true }), "至少 2 秒");
});
