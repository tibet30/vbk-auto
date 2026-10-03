import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProductDetail, PlanningGenerationState } from "../../src/shared/contracts.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createLocalProductService } from "../../src/main/infrastructure/local-product-service.js";
import { TibetProductConflictError } from "../../src/main/infrastructure/tibet-products.js";
import { getProductForRead, deleteRemoteProduct } from "../../src/main/application/remote-product-workflows.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-local-products-"));
  let db = new VbkDatabase(root);
  const store = createAppAuthStore(path.join(root, "test-session.json"));
  const login = (id: number) => store.set({ token: `test-token-${id}`, expiresAt: "2099-01-01 00:00:00",
    user: { id, name: `测试${id}`, phone: `test-${id}`, status: "active", expiresAt: "2099-01-01 00:00:00" } });
  login(1);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, store, login, restart() { db.close(); db = new VbkDatabase(root); } };
}

test("产品、规划、用量在本机持久化，重启后读取不依赖服务端", async t => {
  const f = fixture(t);
  let captures = 0;
  let service = createLocalProductService({ db: f.db, store: f.store, capture: () => captures++ });
  const created = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  const planning: ProductDetail["planning"] = { version: 2, runId: "plan-1", status: "needs_user", currentNode: "poiResolution",
    nodes: [], poiCandidates: [], createdAt: created.updatedAt, updatedAt: created.updatedAt };
  const usage = { events: [], lifetime: { calls: 1, totalTokens: 10 } } as ProductDetail["aiUsage"];
  const legacyState = { localProductId: created.id, status: "needs_user" } as PlanningGenerationState;
  f.db.savePlanningState(legacyState);
  const saved = await service.update({ ...created, planning, aiUsage: usage, vbkAccount: "vbk_test" }, 1);
  f.db.importProductSnapshot(saved); // Existing planning/research callers may round-trip a saved snapshot.
  assert.equal(f.db.getProduct(created.id)?.productJsonVersion, saved.productJsonVersion);
  assert.equal(f.db.loadPlanningState(created.id)?.status, "needs_user");
  f.restart();
  service = createLocalProductService({ db: f.db, store: f.store, capture: () => captures++ });
  const loaded = await getProductForRead(f.db, service, created.id);
  assert.deepEqual(loaded.planning, planning);
  assert.deepEqual(loaded.aiUsage, usage);
  assert.equal(loaded.vbkAccount, "vbk_test");
  assert.equal(loaded.revision, 2);
  assert.equal((await service.list())[0].id, created.id);
  assert.equal(captures, 2);
});

test("切换账号后不读取或改写其他用户的本机产品", async t => {
  const f = fixture(t);
  const service = createLocalProductService({ db: f.db, store: f.store, capture() {} });
  const first = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  f.login(2);
  assert.deepEqual(await service.list(), []);
  await assert.rejects(service.get(first.id), /产品不存在/);
  await assert.rejects(service.update(first, 1), /产品不存在/);
  await assert.rejects(service.upsert(first), /产品不存在/);
  await assert.rejects(service.delete(first.id), /产品不存在/);
  f.login(1);
  assert.equal((await service.get(first.id)).name, first.name);
});

test("本地业务版本变化后拒绝过期快照；本地删除不回写云端", async t => {
  const f = fixture(t);
  const service = createLocalProductService({ db: f.db, store: f.store, capture() {} });
  const first = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  f.db.updateProduct(first.id, { ...first.product, customNote: "newer local edit" }, first.status, first.productJsonVersion);
  await assert.rejects(service.update(first, 1), error => error instanceof TibetProductConflictError);
  assert.equal((await service.get(first.id)).product.customNote, "newer local edit");
  assert.equal(await deleteRemoteProduct(f.db, service, first.id), true);
  assert.deepEqual(await service.list(), []);
});

test("历史云端只读迁移保留本机进度、消息、版本和规划运行记录", async t => {
  const f = fixture(t);
  const local = f.db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
  f.db.updateProduct(local.id, { ...local.product, localOnly: "keep" }, "review", local.productJsonVersion);
  f.db.addMessage(local.id, "user", "本机补充要求");
  f.db.savePlanningState({ localProductId: local.id, status: "needs_user" } as PlanningGenerationState);
  const before = f.db.getProduct(local.id)!;
  let reads = 0;
  const service = createLocalProductService({ db: f.db, store: f.store, capture() {}, legacy: {
    async list() { reads++; return [local]; },
    async get() { reads++; return { ...local, vbkAccount: "vbk_test", revision: 9, status: "planning" }; },
  } });
  assert.equal((await service.list()).length, 1);
  const loaded = await service.get(local.id);
  assert.deepEqual(loaded.product, before.product);
  assert.deepEqual(loaded.messages, before.messages);
  assert.equal(loaded.productJsonVersion, before.productJsonVersion);
  assert.equal(loaded.status, "review");
  assert.equal(loaded.vbkAccount, "vbk_test");
  assert.equal(f.db.loadPlanningState(local.id)?.status, "needs_user");
  await service.list();
  assert.equal(reads, 2);
});

test("旧云端不可用时仍可创建、修改和读取新本机产品", async t => {
  const f = fixture(t);
  const service = createLocalProductService({ db: f.db, store: f.store, capture() {}, legacy: {
    async list() { throw new Error("offline"); }, async get() { throw new Error("offline"); },
  } });
  const first = await service.upsert(f.db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  const saved = await service.update({ ...first, name: "本机产品" }, 1);
  assert.equal((await service.get(first.id)).name, saved.name);
  assert.equal((await service.list())[0].name, saved.name);
});
