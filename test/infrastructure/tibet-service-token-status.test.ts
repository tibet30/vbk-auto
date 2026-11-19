import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTibetServiceTokenStore,
  LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME,
} from "../../src/main/infrastructure/tibet-service-token-store.js";
import { describeTibetServiceToken } from "../../src/main/infrastructure/tibet-service-token-status.js";
import {
  TibetServiceAuthError,
  TibetServiceError,
  type TibetServiceClient,
  type TibetServiceIdentity,
} from "../../src/main/infrastructure/tibet-service-client.js";

const TOKEN = `stk_${"c3".repeat(32)}`;

function storeWithToken(): { store: ReturnType<typeof createTibetServiceTokenStore>; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-status-"));
  const filePath = path.join(dir, LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME);
  const store = createTibetServiceTokenStore(filePath, { env: {} });
  store.save(TOKEN);
  return { store, filePath };
}

function identity(overrides: Partial<TibetServiceIdentity> = {}): TibetServiceIdentity {
  return {
    name: "ansike",
    tokenPrefix: "stk_7d3c74e8",
    permissions: ["read", "create", "edit"],
    permissionLabels: ["只读", "创建", "编辑"],
    status: "active",
    statusLabel: "生效中",
    expiresAt: "2027-05-16 21:10:30",
    remainingDays: 180,
    boundIdentity: { type: "admin", label: "管理员（创建者继承）", key: "admin" },
    lastUsedAt: null,
    useCount: 4,
    ...overrides,
  };
}

function client(selfCheck: () => Promise<TibetServiceIdentity>): TibetServiceClient {
  return {
    configured: () => true,
    selfCheck,
    listServices: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    getService: async () => { throw new Error("unused"); },
  };
}

test("未配置时只读本地状态：明确说「尚未配置」，绝不假装已配置", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-empty-"));
  const store = createTibetServiceTokenStore(path.join(dir, LOCAL_TIBET_SERVICE_TOKEN_FILE_NAME), { env: {} });

  const snapshot = await describeTibetServiceToken(store, { verify: true });
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.source, null);
  assert.equal(snapshot.maskedToken, null);
  assert.equal(snapshot.identity, null);
  assert.match(snapshot.message, /尚未配置/u);
});

test("快照只暴露掩码，明文令牌不会进入返回值", async () => {
  const { store } = storeWithToken();
  const snapshot = await describeTibetServiceToken(store);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.source, "file");
  assert.equal(snapshot.maskedToken, `${TOKEN.slice(0, 12)}…`);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false, "明文令牌不得出现在任何字段里");
  assert.match(snapshot.message, /尚未向服务端验证/u);
  assert.equal(snapshot.verifiedAt, null, "没联网就不该有验证时间");
});

test("验证成功后带回身份、有效期与继承标记", async () => {
  const { store } = storeWithToken();
  const snapshot = await describeTibetServiceToken(store, {
    verify: true,
    client: client(async () => identity()),
  });

  assert.equal(snapshot.identity?.name, "ansike");
  assert.deepEqual(snapshot.identity?.permissions, ["只读", "创建", "编辑"]);
  assert.equal(snapshot.identity?.remainingDays, 180);
  assert.equal(snapshot.identity?.boundType, "admin");
  assert.equal(snapshot.identity?.inherited, true);
  assert.equal(snapshot.identity?.boundKey, "admin");
  assert.ok(snapshot.verifiedAt, "验证成功必须记录时间");
  assert.match(snapshot.message, /服务端已确认/u);
});

test("未绑定身份时如实报「未绑定」，不用 admin 冒充", async () => {
  const { store } = storeWithToken();
  const snapshot = await describeTibetServiceToken(store, {
    verify: true,
    client: client(async () => identity({ boundIdentity: null })),
  });
  assert.equal(snapshot.identity?.boundType, null);
  assert.equal(snapshot.identity?.inherited, false);
});

test("令牌无效/过期属于状态结论：写进 message，不抛异常", async () => {
  const { store } = storeWithToken();
  for (const message of ["服务令牌已过期", "服务令牌无效"]) {
    const snapshot = await describeTibetServiceToken(store, {
      verify: true,
      client: client(async () => { throw new TibetServiceAuthError(message); }),
    });
    assert.equal(snapshot.configured, true, "本地仍然算已保存");
    assert.equal(snapshot.identity, null);
    assert.match(snapshot.message, new RegExp(message, "u"));
    assert.ok(snapshot.verifiedAt, "验证发生过就要留痕");
  }
});

test("网络与协议故障必须抛出，不能被当成「未配置」吞掉", async () => {
  const { store } = storeWithToken();
  await assert.rejects(
    () => describeTibetServiceToken(store, {
      verify: true,
      client: client(async () => { throw new TibetServiceError("暂时无法连接三人同游服务端", 0); }),
    }),
    /暂时无法连接/u,
  );
});
