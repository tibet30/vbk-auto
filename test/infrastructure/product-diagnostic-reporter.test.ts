import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
