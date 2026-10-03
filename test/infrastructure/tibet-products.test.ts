import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createTibetProductService, TibetProductConflictError } from "../../src/main/infrastructure/tibet-products.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
import { productReport } from "../../src/main/infrastructure/product-report.js";

const future = "2099-08-27 12:00:00";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-products-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createAppAuthStore(path.join(root, "session.json"));
  store.set({
    token: "product-token",
    expiresAt: future,
    user: { id: 7, name: "运营", phone: "13800138000", status: "active", expiresAt: future },
  });
  return store;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const product: ProductDetail = {
  id: "17bd40b8-8d30-4c4e-9940-0aa6fa9a7323",
  name: "拉萨3天2晚私家团",
  status: "planning",
  updatedAt: "2026-08-20T10:00:00.000Z",
  product: { basicInfo: { destinationCity: "拉萨" } },
  messages: [],
  researchTasks: [],
};

test("Tibet 产品列表使用登录 token 且解析远端摘要", async (t) => {
  const store = fixture(t);
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.test/api/extension/desktop-products");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer product-token");
      return response({ code: 200, data: [product] });
    },
  });
  assert.deepEqual(await service.list(), [{
    id: product.id,
    name: product.name,
    status: product.status,
    updatedAt: product.updatedAt,
    productId: undefined,
  }]);
});

test("Tibet 产品创建发送业务快照并读取服务端记录", async (t) => {
  const store = fixture(t);
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { client_id: product.id, product });
      return response({ code: 200, data: { created: true, product } }, 201);
    },
  });
  assert.deepEqual(await service.upsert(product), product);
});

test("创建和更新排除本地日志截图与版本，并保留业务和脱敏失败诊断", async t => {
  const local: ProductDetail = {
    ...product,
    revision: 3,
    productJsonVersion: 42,
    basicInfoSaved: true,
    productId: "vbk-123",
    product: {
      ...product.product,
      itinerary: [{ day: 1, spots: [{ poiId: 123, name: "景区" }] }],
      diagnostics: {
        creationInput: { destination: "拉萨", days: 3, productForm: "privateTour" },
        debugSnapshot: { pendingApproval: true, rawPage: "unnecessary" },
        runtime: { status: "failed", rawTrace: "unnecessary", lastToolFailure: {
          name: "upload_cover", arguments: { Authorization: "Bearer private-token", city: "拉萨" },
          error: "token=private-token failed", occurredAt: product.updatedAt,
        } },
      },
    },
    automation: {
      id: "run-1", status: "failed", currentPhase: "basic", phases: [{ phase: "basic", status: "failed" }],
      logs: [{ at: product.updatedAt, message: "local journal", level: "error" }],
      screenshot: "/private/screenshot.png",
      recovery: { phases: { basic: { phase: "basic", state: "needs_user", attempts: [] } } },
    },
  };
  const bodies: ProductDetail[] = [];
  const service = createTibetProductService(fixture(t), {
    baseUrl: "https://example.test",
    fetchImpl: async (_input, init) => {
      const sent = JSON.parse(String(init?.body)).product;
      bodies.push(sent);
      return response({ code: 200, data: { product: { ...sent, revision: 4 } } });
    },
  });
  const created = await service.upsert(local);
  const updated = await service.update(local, 3);
  assert.deepEqual(bodies[0], bodies[1]);
  const sent = bodies[0];
  assert.equal("revision" in sent, false);
  assert.equal("productJsonVersion" in sent, false);
  assert.equal("screenshot" in sent.automation!, false);
  assert.deepEqual(sent.automation?.logs, []);
  assert.deepEqual(sent.automation?.recovery, local.automation?.recovery);
  assert.deepEqual(sent.product.itinerary, local.product.itinerary);
  assert.equal(sent.productId, "vbk-123");
  assert.equal(sent.basicInfoSaved, true);
  const serialized = JSON.stringify(sent);
  assert.equal(serialized.includes("private-token"), false);
  assert.equal(serialized.includes("unnecessary"), false);
  assert.equal(serialized.includes("upload_cover"), true);
  for (const result of [created, updated]) {
    assert.deepEqual(result.automation?.logs, local.automation?.logs);
    assert.equal(result.automation?.screenshot, local.automation?.screenshot);
    assert.equal(result.productJsonVersion, 42);
    assert.equal(result.revision, 4);
  }
  assert.equal(JSON.stringify(local).includes("private-token"), true, "projection must not mutate local state");
});

test("上报完整保留规划、核查、会话和 AI 用量，失败参数有大小上限", () => {
  const local = {
    ...product,
    planning: { version: 2, runId: "plan", status: "needs_user", currentNode: "poiResolution", nodes: [], poiCandidates: [], createdAt: "now", updatedAt: "now" },
    researchTasks: [{ id: "task", label: "景区确认", type: "vbk", status: "succeeded", state: "confirmed", evidence: [] }],
    messages: [{ id: "m1", role: "user", content: "修改行程", createdAt: "now" }],
    aiUsage: { events: [], lifetime: { calls: 1, totalTokens: 100 } },
    product: { diagnostics: { runtime: { lastToolFailure: {
      name: "tool", arguments: { payload: "a".repeat(10_000) }, error: "e".repeat(3000),
    } } } },
  } as unknown as ProductDetail;
  const sent = productReport(local);
  for (const key of ["planning", "researchTasks", "messages", "aiUsage"] as const) assert.deepEqual(sent[key], local[key]);
  const diagnostics = sent.product.diagnostics as any;
  assert.equal(diagnostics.runtime.lastToolFailure.arguments.truncated, true);
  assert.equal(diagnostics.runtime.lastToolFailure.arguments.preview.length, 8000);
  assert.equal(diagnostics.runtime.lastToolFailure.error.length, 2000);
});

test("本地执行耗时不随产品创建和更新提交到远端", async t => {
  const store = fixture(t);
  const local = { ...product, executionTime: { elapsedMs: 3000, running: false, historicalIncomplete: false } };
  const sent: unknown[] = [];
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)).product);
      return response({ code: 200, data: { product } });
    },
  });
  await service.upsert(local);
  await service.update(local, 1);
  assert.deepEqual(sent, [product, product]);
  assert.equal(local.executionTime.elapsedMs, 3000);
});

test("Tibet 产品详情保留 aiUsage 且不混入 product 正文", async (t) => {
  const store = fixture(t);
  const withUsage: ProductDetail = {
    ...product,
    revision: 2,
    aiUsage: {
      events: [{
        id: "evt-1",
        source: "planning.structureLocation",
        model: "test-model",
        provider: "minimax",
        status: "ok",
        startedAt: "2026-08-23T10:00:00.000Z",
        endedAt: "2026-08-23T10:00:01.000Z",
        durationMs: 1000,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        estimatedCostCny: 0.02,
      }],
      lifetime: {
        calls: 1,
        durationMs: 1000,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        tokensIncomplete: false,
        estimatedCostCny: 0.02,
      },
      latestRun: {
        calls: 1,
        durationMs: 1000,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        tokensIncomplete: false,
        estimatedCostCny: 0.02,
      },
      byStage: [],
    },
  };
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => response({ code: 200, data: { product: withUsage } }),
  });
  const got = await service.get(product.id);
  assert.equal(got.aiUsage?.lifetime.totalTokens, 15);
  assert.equal(got.aiUsage?.lifetime.estimatedCostCny, 0.02);
  assert.equal("aiUsage" in (got.product as object), false);
});

test("Tibet 产品接口 401 会清除本地会话", async (t) => {
  const store = fixture(t);
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => response({ code: 401, message: "登录令牌无效" }, 401),
  });
  await assert.rejects(service.list(), /登录令牌无效/);
  assert.equal(store.get(), null);
});

test("Tibet PATCH 携带 expected_revision，并把 409 转成带最新快照的冲突错误", async (t) => {
  const store = fixture(t);
  const latest = { ...product, revision: 4, name: "较新产品" };
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), `https://example.test/api/extension/desktop-products/${product.id}`);
      assert.equal(init?.method, "PATCH");
      assert.equal(JSON.parse(String(init?.body)).expected_revision, 3);
      return response({ code: 409, message: "revision conflict", data: { product: latest } }, 409);
    },
  });
  await assert.rejects(
    service.update({ ...product, revision: 3 }, 3),
    (error: unknown) => error instanceof TibetProductConflictError && error.latest.name === "较新产品",
  );
});

test("Tibet 非 JSON 响应保留通用 HTTP 诊断", async (t) => {
  const store = fixture(t);
  const service = createTibetProductService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => new Response("<!doctype html><h1>Not Found</h1>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  await assert.rejects(service.list(), /desktop-products.*HTTP 404/);
});
