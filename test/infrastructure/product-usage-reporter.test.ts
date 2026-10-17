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
import { buildProductUsageReport } from "../../src/main/application/product-usage-builder.js";

const env = { appVersion: "test", platform: "darwin", arch: "arm64" };
const event: AiUsageEvent = { id: "usage-1", runId: "run-1", source: "chat.reply", model: "MiniMax-M3", provider: "minimax", status: "ok",
  startedAt: "2026-10-03T10:00:00Z", endedAt: "2026-10-03T10:00:01Z", durationMs: 1000,
  inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedTokens: 100 };

test("AI 用量保留在本地但不再进入诊断待发队列", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-no-usage-report-"));
  const db = new VbkDatabase(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = createAppAuthStore(path.join(root, "session.json"));
  store.set({ token: "test", expiresAt: "2099-01-01", user: { id: 1, name: "测试", phone: "test", status: "active", expiresAt: "2099-01-01" } });
  let sends = 0;
  const reporter = createProductDiagnosticReporter({ db, store, environment: () => env,
    fetchImpl: async () => { sends++; return new Response("{}"); } });
  const service = createLocalProductService({ db, store, capture: product => reporter.capture(product) });
  const product = await service.upsert({ ...db.buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" }),
    aiUsage: appendAiUsage(undefined, [event]) } as ProductDetail);
  reporter.capture(product);
  await reporter.flush();
  assert.equal(sends, 0);
  assert.equal(db.pendingDiagnostics(1).length, 0);
  assert.equal(db.getProduct(product.id)?.aiUsage?.lifetime.totalTokens, 1200);
});

test("本地用量汇总能力继续服务界面，未知费用保持空值", () => {
  const unknown = { ...event, model: "unknown-model", totalTokens: null, inputTokens: null, outputTokens: null };
  const snapshot = { events: [{ data: { aiUsage: unknown } }] } as AgentSnapshot;
  const product = { id: "product-1", name: "测试", product: {}, messages: [] } as unknown as ProductDetail;
  const report = buildProductUsageReport(product, env, snapshot)!;
  assert.equal(report.usage.totals.tokensIncomplete, true);
  assert.equal(report.usage.totals.totalTokens, null);
  assert.equal(report.usage.totals.estimatedCostCny, null);
});
