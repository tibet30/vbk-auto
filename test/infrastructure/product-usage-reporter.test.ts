import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createLocalProductService } from "../../src/main/infrastructure/local-product-service.js";
import { createProductDiagnosticReporter } from "../../src/main/infrastructure/product-diagnostic-reporter.js";
import { appendAiUsage } from "../../src/main/ai/ai-usage-merge.js";
import type { AiUsageEvent, ProductDetail, AgentSnapshot } from "../../src/shared/contracts.js";
import type { ProductUsageReport } from "../../src/shared/product-usage-report.js";
import { buildProductUsageReport } from "../../src/main/application/product-usage-builder.js";

const env = { appVersion: "test", platform: "darwin", arch: "arm64" };
const event: AiUsageEvent = { id: "usage-1", runId: "run-1", source: "chat.reply", model: "MiniMax-M3", provider: "minimax", status: "ok",
  startedAt: "2026-10-03T10:00:00Z", endedAt: "2026-10-03T10:00:01Z", durationMs: 1000,
  inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedTokens: 100 };

test("后台用量仅传汇总，持久化断网补传、回包核对、账号隔离与重复去重", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-usage-report-"));
  let db = new VbkDatabase(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = createAppAuthStore(path.join(root, "session.json"));
  const login = (id: number) => store.set({ token: `test-${id}`, expiresAt: "2099-01-01", user: { id, name: "测试", phone: "test", status: "active", expiresAt: "2099-01-01" } });
  login(1);
  const service = createLocalProductService({ db, store, capture() {} });
  const product = await service.upsert({ ...db.buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" }),
    aiUsage: appendAiUsage(undefined, [event]), messages: [], product: { privateContent: "DO_NOT_UPLOAD" } } as ProductDetail);
  let reporter = createProductDiagnosticReporter({ db, store, environment: () => env, fetchImpl: async () => { throw new Error("offline"); } });
  reporter.capture(product);
  await reporter.flush();
  assert.equal(db.pendingDiagnostics(1).length, 1);
  db.close(); db = new VbkDatabase(root);
  login(2);
  let sends = 0;
  reporter = createProductDiagnosticReporter({ db, store, environment: () => env, fetchImpl: async () => { sends++; return new Response("{}"); } });
  await reporter.flush();
  assert.equal(sends, 0);
  login(1);
  await reporter.flush();
  assert.equal(db.pendingDiagnostics(1).length, 1, "200 without product and report IDs is not an acknowledgement");
  const bodies: ProductUsageReport[] = [];
  reporter = createProductDiagnosticReporter({ db, store, environment: () => env, baseUrl: "https://example.test", fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://example.test/api/extension/desktop-usage");
    const body = JSON.parse(String(init!.body)); bodies.push(body);
    return new Response(JSON.stringify({ code: 200, data: { clientId: body.clientId, eventId: body.reportId } }));
  } });
  await reporter.flush();
  assert.equal(db.pendingDiagnostics(1).length, 0);
  assert.equal(bodies[0].usage.totals.totalTokens, 1200);
  assert.equal(bodies[0].usage.totals.estimatedCostCny, 0.0036);
  assert.equal(bodies[0].usage.models[0].rateCnyPerMillion?.inputPerMillion, 2.1);
  assert.equal(JSON.stringify(bodies).includes("DO_NOT_UPLOAD"), false);
  assert.equal("events" in bodies[0].usage, false);
  reporter.capture({ ...product, name: "新名称", updatedAt: new Date().toISOString() });
  await reporter.flush();
  assert.equal(bodies.length, 1, "ordinary edits and same usage do not re-upload");
  reporter.capture({ ...product, aiUsage: appendAiUsage(product.aiUsage, [{ ...event, id: "usage-2" }]) });
  await reporter.flush();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].usage.totals.totalTokens, 2400);
});

test("Agent 快照中的消耗与界面合并口径一致，未知费用保持空值", () => {
  const unknown = { ...event, model: "unknown-model", totalTokens: null, inputTokens: null, outputTokens: null };
  const snapshot = { events: [{ data: { aiUsage: unknown } }] } as AgentSnapshot;
  const product = { id: "product-1", name: "测试", product: {}, messages: [] } as unknown as ProductDetail;
  const report = buildProductUsageReport(product, env, snapshot)!;
  assert.equal(report.usage.totals.tokensIncomplete, true);
  assert.equal(report.usage.totals.totalTokens, null);
  assert.equal(report.usage.totals.estimatedCostCny, null);
  assert.equal(report.usage.models[0].rateCnyPerMillion, null);
});
