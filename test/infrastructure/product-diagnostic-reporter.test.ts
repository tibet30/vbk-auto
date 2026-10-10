import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AgentSnapshot } from "../../src/shared/contracts.js";
import type { ProductDiagnosticReport } from "../../src/shared/product-diagnostic-report.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createLocalProductService } from "../../src/main/infrastructure/local-product-service.js";
import { createProductDiagnosticReporter } from "../../src/main/infrastructure/product-diagnostic-reporter.js";

const env = { appVersion: "test-1", platform: "darwin", arch: "arm64" };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-diagnostic-outbox-"));
  let db = new VbkDatabase(root);
  const store = createAppAuthStore(path.join(root, "test-session.json"));
  const login = (id: number) => store.set({ token: `test-token-${id}`, expiresAt: "2099-01-01 00:00:00",
    user: { id, name: "测试", phone: `test-${id}`, status: "active", expiresAt: "2099-01-01 00:00:00" } });
  login(1);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, store, login, restart() { db.close(); db = new VbkDatabase(root); } };
}
function acknowledge(report: ProductDiagnosticReport): Response {
  return new Response(JSON.stringify({ code: 200, data: { clientId: report.clientId, eventId: report.failure?.eventId ?? null } }));
}
function failureSnapshot(id: string): AgentSnapshot {
  return { localProductId: id, run: { id: "run-1", status: "paused", createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:03Z" }, events: [
    { id: "u1", runId: "run-1", type: "user", content: "请使用四星酒店", createdAt: "2026-10-03T00:00:00Z" },
    { id: "c1", runId: "run-1", type: "tool_call", content: "查询酒店", createdAt: "2026-10-03T00:00:01Z",
      data: { toolCallId: "call-1", name: "query_hotel", arguments: { city: "潮州", accessToken: "hidden-secret" } } },
    { id: "f1", runId: "run-1", type: "tool_result", content: "失败", createdAt: "2026-10-03T00:00:02Z",
      data: { toolCallId: "call-1", error: "酒店接口超时" } },
  ] };
}

test("只上报原始输入和失败，普通产品变更不上传，重复/恢复事件不会重复发送", async t => {
  const f = fixture(t);
  const bodies: ProductDiagnosticReport[] = [];
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    baseUrl: "https://example.test", fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.test/api/extension/desktop-diagnostics");
      const report = JSON.parse(String(init?.body)); bodies.push(report); return acknowledge(report);
    } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => reporter.capture(product) });
  let product = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour", userIdea: "慢一点" }));
  await reporter.flush();
  product = await service.update({ ...product, product: { ...product.product, generatedContent: "DO_NOT_UPLOAD" } }, 1);
  await reporter.flush();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].creationInput, { destination: "潮州", days: 2, productForm: "privateTour", userIdea: "慢一点" });
  const snapshot = failureSnapshot(product.id);
  reporter.capture(product, snapshot);
  await reporter.flush();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].failure?.tool, "query_hotel");
  assert.equal(bodies[1].failure?.instruction, "请使用四星酒店");
  assert.equal(JSON.stringify(bodies).includes("DO_NOT_UPLOAD"), false);
  assert.equal(JSON.stringify(bodies).includes("hidden-secret"), false);
  reporter.capture(product, { ...snapshot, run: { ...snapshot.run!, status: "completed" } });
  await reporter.flush();
  assert.equal(bodies.length, 2);
});

test("断网和未确认回包保留队列，重启后补传，诊断失败不阻塞本机保存", async t => {
  const f = fixture(t);
  let reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async () => { throw new Error("offline"); } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => reporter.capture(product) });
  const product = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 1);
  assert.ok(f.db.getProduct(product.id));
  f.restart();
  reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async () => new Response(JSON.stringify({ code: 200, data: {} })) });
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 1, "HTTP 200 alone is not an acknowledgement");
  reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async (_input, init) => acknowledge(JSON.parse(String(init?.body))) });
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
  reporter.capture(f.db.getProduct(product.id)!);
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 0, "receipt survives restart and prevents re-upload");
});

test("待上传事件按账号隔离，切换用户不会携带前一个用户的诊断", async t => {
  const f = fixture(t);
  const deferred = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async () => { throw new Error("offline"); } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => deferred.capture(product) });
  await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  await deferred.flush();
  f.login(2);
  let sent = 0;
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async (_input, init) => { sent++; return acknowledge(JSON.parse(String(init?.body))); } });
  await reporter.flush();
  assert.equal(sent, 0);
  assert.equal(f.db.pendingDiagnostics(1).length, 1);
  f.login(1);
  await reporter.flush();
  assert.equal(sent, 1);
});

test("HTML 404 逐步退避、合并重复日志，恢复后补传并重置退避", async t => {
  const f = fixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  let timestamp = 0;
  let requests = 0;
  let available = false;
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    now: () => timestamp, fetchImpl: async (_input, init) => {
      requests++;
      return available ? acknowledge(JSON.parse(String(init?.body)))
        : new Response("\n<!doctype html><title>Not Found</title>", { status: 404, headers: { "Content-Type": "text/html" } });
    } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => reporter.capture(product) });
  const product = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  await reporter.flush();
  for (let i = 0; i < 10; i++) { reporter.capture(product); await reporter.flush(); }
  assert.equal(requests, 1);
  assert.equal(warnings.mock.callCount(), 1);
  const warning = JSON.stringify(warnings.mock.calls[0].arguments);
  assert.match(warning, /desktop-diagnostics.*HTTP 404/);
  assert.doesNotMatch(warning, /Unexpected token|<!doctype/);
  assert.equal(f.db.pendingDiagnostics(1).length, 1);
  timestamp = 60_000;
  await reporter.flush();
  assert.equal(requests, 2);
  assert.equal(warnings.mock.callCount(), 1);
  timestamp = 120_000;
  await reporter.flush();
  assert.equal(requests, 2, "second failure delays retries for two minutes");
  available = true;
  timestamp = 180_000;
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
  reporter.capture(product, failureSnapshot(product.id));
  await reporter.flush();
  assert.equal(requests, 4, "successful upload resets cooldown for new events");
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
});

test("账号切换不受其他账号退避影响，重新登录后立即重试", async t => {
  const f = fixture(t);
  t.mock.method(console, "warn", () => {});
  let requests = 0;
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    now: () => 0, fetchImpl: async () => { requests++; throw new Error("offline"); } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => reporter.capture(product) });
  await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  await reporter.flush();
  f.login(2);
  await service.upsert(f.db.buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" }));
  await reporter.flush();
  assert.equal(requests, 2);
  f.login(1);
  await reporter.flush();
  assert.equal(requests, 2, "previous account retains its own cooldown");
  f.store.set({ ...f.store.get()!, token: "renewed-token" });
  await reporter.flush();
  assert.equal(requests, 3);
});

test("真实本机 HTTP：HTML 响应不丢队列，JSON 确认后持久化回执", async t => {
  const f = fixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  let timestamp = 0;
  let available = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/api/extension/desktop-diagnostics");
    assert.equal(request.headers.accept, "application/json");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const report = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("Content-Type", available ? "application/json" : "text/html");
    response.end(available ? JSON.stringify({ code: 200, data: { clientId: report.clientId, eventId: null } })
      : "\n<!doctype html><title>Proxy page</title>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    baseUrl: `http://127.0.0.1:${address.port}`, now: () => timestamp });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => reporter.capture(product) });
  const product = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 1);
  assert.match(JSON.stringify(warnings.mock.calls[0].arguments), /非 JSON.*desktop-diagnostics.*HTTP 200.*text\/html/);
  assert.ok(f.db.getProduct(product.id));
  available = true;
  timestamp = 60_000;
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
  f.restart();
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
  assert.ok(f.db.getProduct(product.id));
});
