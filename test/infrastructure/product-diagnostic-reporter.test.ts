import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSnapshot } from "../../src/shared/contracts.js";
import type { ProductDiagnosticReport } from "../../src/shared/product-diagnostic-report.js";
import type { ProductUsageReport } from "../../src/shared/product-usage-report.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createLocalProductService } from "../../src/main/infrastructure/local-product-service.js";
import { createProductDiagnosticReporter } from "../../src/main/infrastructure/product-diagnostic-reporter.js";

const env = { appVersion: "test-1", platform: "darwin", arch: "arm64" };
const at = "2026-10-15T10:00:00+08:00";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-diagnostic-outbox-"));
  let db = new VbkDatabase(root);
  const store = createAppAuthStore(path.join(root, "session.json"));
  store.set({ token: "test-token", expiresAt: "2099-01-01 00:00:00",
    user: { id: 1, name: "测试", phone: "test", status: "active", expiresAt: "2099-01-01 00:00:00" } });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, store, restart() { db.close(); db = new VbkDatabase(root); } };
}
function acknowledge(report: ProductDiagnosticReport): Response {
  return new Response(JSON.stringify({ code: 200, data: { clientId: report.clientId, eventId: report.issue.eventId } }));
}
function paused(id: string): AgentSnapshot {
  return { localProductId: id, run: { id: "r1", status: "paused", createdAt: at, updatedAt: at }, events: [
    { id: "pause-1", runId: "r1", type: "status", content: "酒店规则未通过", createdAt: at, data: { status: "paused" } },
  ] };
}

test("普通产品变化、AI 用量和正常等待均不创建上报", async t => {
  const f = fixture(t);
  let calls = 0;
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async () => { calls++; return new Response("{}"); } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture: product => reporter.capture(product) });
  const product = await service.upsert(f.db.buildProductSnapshot({ destination: "成都", days: 2, productForm: "freeTravel" }));
  reporter.capture({ ...product, aiUsage: { lifetime: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2,
    cachedTokens: 0, estimatedCostCny: 0.1, tokensIncomplete: false, costIncomplete: false }, latestRun: {
      calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCostCny: 0.1,
      tokensIncomplete: false, costIncomplete: false } } });
  reporter.capture(product, { localProductId: product.id, run: { id: "r1", status: "waiting_approval", createdAt: at, updatedAt: at }, events: [] });
  await reporter.flush();
  assert.equal(calls, 0);
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
});

test("系统异常只发送 v2 最小原因且幂等", async t => {
  const f = fixture(t);
  const bodies: ProductDiagnosticReport[] = [];
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    baseUrl: "https://example.test", fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://example.test/api/extension/desktop-diagnostics");
      const body = JSON.parse(String(init?.body)) as ProductDiagnosticReport; bodies.push(body); return acknowledge(body);
    } });
  const service = createLocalProductService({ db: f.db, store: f.store, capture() {} });
  const product = await service.upsert(f.db.buildProductSnapshot({ destination: "成都", days: 2, productForm: "freeTravel",
    userIdea: "DO_NOT_UPLOAD" }));
  reporter.capture(product, paused(product.id));
  reporter.capture(product, paused(product.id));
  await reporter.flush();
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0]!).sort(), ["clientId", "environment", "issue", "name", "schemaVersion"]);
  assert.deepEqual(Object.keys(bodies[0]!.issue).sort(), ["eventId", "occurredAt", "reason", "source", "stage", "state"]);
  assert.equal(JSON.stringify(bodies).includes("DO_NOT_UPLOAD"), false);
});

test("旧待发失败先最小化；旧空诊断和用量在本机结清", async t => {
  const f = fixture(t);
  f.db.enqueueDiagnostic(1, "legacy-failure", { schemaVersion: 1, clientId: "p1", name: "旧产品",
    creationInput: { userIdea: "DO_NOT_UPLOAD" }, environment: env, failure: { eventId: "legacy-event", stage: "itinerary",
      error: "规划失败 token=secret", occurredAt: at, arguments: { raw: "DO_NOT_UPLOAD" } } } as never);
  f.db.enqueueDiagnostic(1, "legacy-empty", { schemaVersion: 1, clientId: "p1", name: "旧产品",
    creationInput: { userIdea: "DO_NOT_UPLOAD" }, environment: env, failure: null });
  f.db.enqueueDiagnostic(1, "legacy-usage", { schemaVersion: 1, reportType: "usage", reportId: "u1", clientId: "p1",
    name: "旧产品", observedAt: at, environment: env, usage: { private: "DO_NOT_UPLOAD" } } as unknown as ProductUsageReport);
  const bodies: ProductDiagnosticReport[] = [];
  const reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return acknowledge(body); } });
  await reporter.flush();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.schemaVersion, 2);
  assert.equal(bodies[0]!.issue.reason.includes("secret"), false);
  assert.equal(JSON.stringify(bodies).includes("DO_NOT_UPLOAD"), false);
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
});

test("断网保留最小事件，重启后凭严格回执结清", async t => {
  const f = fixture(t);
  const service = createLocalProductService({ db: f.db, store: f.store, capture() {} });
  const product = await service.upsert(f.db.buildProductSnapshot({ destination: "成都", days: 2, productForm: "freeTravel" }));
  let reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async () => { throw new Error("offline"); } });
  reporter.capture(product, paused(product.id));
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 1);
  f.restart();
  reporter = createProductDiagnosticReporter({ db: f.db, store: f.store, environment: () => env,
    fetchImpl: async (_url, init) => acknowledge(JSON.parse(String(init?.body))) });
  await reporter.flush();
  assert.equal(f.db.pendingDiagnostics(1).length, 0);
});
