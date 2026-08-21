import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createTibetProductService, TibetProductConflictError } from "../../src/main/infrastructure/tibet-products.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

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

test("Tibet 产品创建发送完整快照并读取服务端记录", async (t) => {
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
