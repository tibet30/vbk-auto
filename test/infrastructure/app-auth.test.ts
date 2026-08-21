import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createTibetAuthService, resolveTibetApiBaseUrl } from "../../src/main/infrastructure/tibet-auth.js";
import { validateIpcArguments } from "../../src/main/infrastructure/ipc-input.js";

const future = "2099-08-27 12:00:00";
const user = { id: 12, name: "运营小王", phone: "13800138000", status: "active", expiresAt: future };
const otherUser = { id: 13, name: "运营小李", phone: "13900139000", status: "active", expiresAt: future };

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-app-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "session.json");
  return { filePath, store: createAppAuthStore(filePath) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("app auth store 原子保存 token 且文件仅 owner 可读写", (t) => {
  const { filePath, store } = fixture(t);
  store.set({ token: "secret-token", expiresAt: future, user });
  assert.equal(store.get()?.token, "secret-token");
  assert.equal(createAppAuthStore(filePath).get()?.user.name, "运营小王");
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("app auth store 按用户保留多个会话并可切换活动账号", (t) => {
  const { filePath, store } = fixture(t);
  store.set({ token: "token-wang", expiresAt: future, user });
  store.set({ token: "token-li", expiresAt: future, user: otherUser });
  assert.equal(store.get()?.user.id, otherUser.id);
  assert.deepEqual(new Set(store.list().map((session) => session.user.id)), new Set([user.id, otherUser.id]));

  store.deactivate();
  assert.equal(store.get(), null);
  assert.equal(store.list().length, 2);
  assert.equal(createAppAuthStore(filePath).get(), null);

  assert.equal(store.activate(user.id)?.token, "token-wang");
  assert.equal(store.get()?.user.id, user.id);
  store.clear();
  assert.equal(store.get(), null);
  assert.deepEqual(store.list().map((session) => session.user.id), [otherUser.id]);
});

test("旧版单账号会话文件会无损迁移为可切换账号", (t) => {
  const { filePath } = fixture(t);
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    token: "legacy-token",
    expiresAt: future,
    user,
  }), { mode: 0o600 });
  const store = createAppAuthStore(filePath);
  assert.equal(store.get()?.token, "legacy-token");
  assert.deepEqual(store.list().map((session) => session.user.id), [user.id]);
});

test("无本地 token 时不请求远端，直接返回未登录", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  });
  assert.deepEqual(await auth.status(), { state: "unauthenticated" });
  assert.equal(calls, 0);
});

test("有效 token 通过 extension/auth/me 恢复登录并更新用户摘要", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "valid-token", expiresAt: future, user });
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.test/api/extension/auth/me");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer valid-token");
      return jsonResponse({ code: 200, data: { id: 12, name: "新名字", phone: user.phone, status: "active", expires_at: future } });
    },
  });
  assert.deepEqual(await auth.status(), { state: "authenticated", user: { ...user, name: "新名字" } });
  assert.equal(store.get()?.user.name, "新名字");
});

test("401/403 会清掉失效 token 并回到登录页", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "expired-token", expiresAt: future, user });
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => jsonResponse({ code: 401, message: "登录令牌无效" }, 401),
  });
  assert.deepEqual(await auth.status(), { state: "unauthenticated" });
  assert.equal(store.get(), null);
});

test("临时断网返回 unavailable，但保留本地 token 供重试", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "keep-token", expiresAt: future, user });
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(await auth.status(), {
    state: "unavailable",
    message: "暂时无法连接账号服务，请检查网络后重试。",
    cachedUser: user,
  });
  assert.equal(store.get()?.token, "keep-token");
});

test("验证码与登录均使用 Tibet extension 专用接口，成功后持久化 token", async (t) => {
  const { store } = fixture(t);
  const paths: string[] = [];
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith("/captcha")) {
        return jsonResponse({ code: 200, data: { captcha_id: "cap-1", image_base64: "data:image/png;base64,AA==" } });
      }
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { phone: user.phone, password: "correct-password", captcha_id: "cap-1", captcha_code: "ABCD" });
      return jsonResponse({ code: 200, data: { token: "new-token", expires_at: future, user } });
    },
  });
  assert.deepEqual(await auth.captcha(), { captchaId: "cap-1", imageDataUrl: "data:image/png;base64,AA==" });
  assert.equal((await auth.login({ phone: user.phone, password: "correct-password", captchaId: "cap-1", captchaCode: "abcd" })).state, "authenticated");
  assert.deepEqual(paths, ["/api/extension/captcha", "/api/extension/auth/login"]);
  assert.equal(store.get()?.token, "new-token");
});

test("历史账号切换先验证目标 token，成功后才改变活动账号", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "token-wang", expiresAt: future, user });
  store.set({ token: "token-li", expiresAt: future, user: otherUser });
  store.activate(user.id);
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token-li");
      return jsonResponse({ code: 200, data: { ...otherUser, expires_at: future } });
    },
  });

  assert.deepEqual(await auth.switchAccount(otherUser.id), { state: "authenticated", user: otherUser });
  assert.equal(store.get()?.user.id, otherUser.id);
  const snapshot = await auth.listAccounts();
  assert.equal(snapshot.currentUserId, otherUser.id);
  assert.equal("token" in snapshot.saved[0], false, "renderer-safe account summary must not expose token");
});

test("目标历史会话失效时只移除目标账号，当前账号保持不变", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "token-wang", expiresAt: future, user });
  store.set({ token: "token-li", expiresAt: future, user: otherUser });
  store.activate(user.id);
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => jsonResponse({ code: 401, message: "登录令牌无效" }, 401),
  });

  await assert.rejects(auth.switchAccount(otherUser.id), /登录状态已失效/);
  assert.equal(store.get()?.user.id, user.id);
  assert.deepEqual(store.list().map((session) => session.user.id), [user.id]);
});

test("登录其他账号只退出当前选择，不注销已保存的历史会话", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "token-wang", expiresAt: future, user });
  const auth = createTibetAuthService(store, { baseUrl: "https://example.test" });
  await auth.startLogin();
  assert.equal(store.get(), null);
  assert.deepEqual((await auth.listAccounts()).saved.map((account) => account.user.id), [user.id]);
});

test("退出时即使远端不可用也会清理本地 token", async (t) => {
  const { store } = fixture(t);
  store.set({ token: "logout-token", expiresAt: future, user });
  const auth = createTibetAuthService(store, {
    baseUrl: "https://example.test",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await assert.rejects(auth.logout(), /暂时无法连接账号服务/);
  assert.equal(store.get(), null);
});

test("Tibet 地址只允许 HTTPS 或本机 loopback HTTP", () => {
  assert.equal(resolveTibetApiBaseUrl("https://www.atdtour.com/api"), "https://www.atdtour.com");
  assert.equal(resolveTibetApiBaseUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.throws(() => resolveTibetApiBaseUrl("http://example.com"), /必须使用 HTTPS/);
});

test("appAuth:login IPC 在进入服务前拒绝畸形和额外字段", () => {
  const valid = { phone: user.phone, password: "password", captchaId: "cap", captchaCode: "ABCD" };
  assert.doesNotThrow(() => validateIpcArguments("appAuth:login", [valid]));
  assert.throws(() => validateIpcArguments("appAuth:login", [{ ...valid, phone: "123" }]), /invalid arguments/);
  assert.throws(() => validateIpcArguments("appAuth:login", [{ ...valid, token: "injected" }]), /invalid arguments/);
});
