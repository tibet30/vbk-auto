import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createTibetVbkBindingService } from "../../src/main/infrastructure/tibet-vbk-bindings.js";
import type { VbkBinding } from "../../src/shared/contracts-vbk-binding.js";

const future = "2099-08-27 12:00:00";

const sample: VbkBinding = {
  vbkAccountKey: "vbk_671205",
  vbkAccountName: "党荣",
  providerId: 123456,
  servicePhone: "400-xxx-xxxx",
  butler: {
    contactCardId: 1,
    displayName: "小王",
    providerId: 123456,
  },
  lastUsedAt: "2026-08-23T10:00:00+08:00",
  updatedAt: "2026-08-23T10:00:00+08:00",
};

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-bindings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createAppAuthStore(path.join(root, "session.json"));
  store.set({
    token: "binding-token",
    expiresAt: future,
    user: { id: 7, name: "运营", phone: "13800138000", status: "active", expiresAt: future },
  });
  return store;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Tibet VBK 绑定列表使用登录 token 且解析 items/activeVbkAccountKey", async (t) => {
  const store = fixture(t);
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.test/api/extension/vbk-bindings");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer binding-token");
      return response({
        code: 200,
        data: { items: [sample], activeVbkAccountKey: sample.vbkAccountKey },
      });
    },
  });
  assert.deepEqual(await service.list(), {
    items: [sample],
    activeVbkAccountKey: sample.vbkAccountKey,
  });
});

test("Tibet VBK 绑定 upsert 走 PUT 路径并回传服务端记录", async (t) => {
  const store = fixture(t);
  const patch = {
    vbkAccountName: "党荣",
    providerId: 123456,
    servicePhone: "400-xxx-xxxx",
    butler: sample.butler,
  };
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.test/api/extension/vbk-bindings/vbk_671205");
      assert.equal(init?.method, "PUT");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), patch);
      return response({ code: 200, data: sample });
    },
  });
  assert.deepEqual(await service.upsert("vbk_671205", patch), sample);
});

test("Tibet VBK 绑定 activate 走 POST /activate", async (t) => {
  const store = fixture(t);
  const activated = { ...sample, lastUsedAt: "2026-08-23T12:00:00+08:00" };
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.test/api/extension/vbk-bindings/vbk_671205/activate");
      assert.equal(init?.method, "POST");
      return response({ code: 200, data: activated });
    },
  });
  assert.deepEqual(await service.activate("vbk_671205"), activated);
});

test("Tibet VBK 绑定 delete 走 DELETE", async (t) => {
  const store = fixture(t);
  let called = false;
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      called = true;
      assert.equal(String(input), "https://example.test/api/extension/vbk-bindings/vbk_671205");
      assert.equal(init?.method, "DELETE");
      return response({ code: 200, data: { deleted: true } });
    },
  });
  await service.delete("vbk_671205");
  assert.equal(called, true);
});

test("Tibet VBK 绑定接口 401 会清除本地会话并抛中文错误", async (t) => {
  const store = fixture(t);
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => response({ code: 401, message: "登录令牌无效" }, 401),
  });
  await assert.rejects(service.list(), /登录令牌无效/);
  assert.equal(store.get(), null);
});

test("Tibet VBK 绑定在缺少会话时抛出登录提示", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-bindings-empty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createAppAuthStore(path.join(root, "session.json"));
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => {
      throw new Error("不应发起请求");
    },
  });
  await assert.rejects(service.list(), /请先登录应用账号/);
});

test("Tibet VBK 绑定非 JSON 响应保留通用 HTTP 诊断", async (t) => {
  const store = fixture(t);
  const service = createTibetVbkBindingService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => new Response("<!doctype html><h1>Not Found</h1>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  await assert.rejects(service.list(), /vbk-bindings.*HTTP 404/);
});
