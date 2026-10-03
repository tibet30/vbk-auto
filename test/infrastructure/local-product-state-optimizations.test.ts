import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDatabaseMigrations } from "../../src/main/infrastructure/database/parts/migration-registry.js";
import { createProduct } from "../../src/main/infrastructure/database/parts/products.js";
import { attachLocalProductState, listOwnedLocalProductSummaries } from "../../src/main/infrastructure/database/parts/local-product-state.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";
import { createLocalProductService } from "../../src/main/infrastructure/local-product-service.js";

test("本机产品摘要列表只查询一次状态与产品，不加载详情关联表", () => {
  const statements: string[] = [];
  const db = new Database(":memory:", { verbose: (statement) => statements.push(statement) });
  runDatabaseMigrations(db);
  try {
    const products = [1, 2, 3].map((days) => createProduct(db, { destination: "潮州", days, productForm: "privateTour" }));
    for (const [index, product] of products.entries()) {
      attachLocalProductState(db, { ...product, vbkAccount: `vbk-${index}` }, 7, index + 1);
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(`m-${index}`, product.id, "user", "详情不应读取", null, product.updatedAt);
    }
    statements.length = 0;
    const summaries = listOwnedLocalProductSummaries(db, 7);
    assert.equal(summaries.length, 3);
    assert.deepEqual(new Set(summaries.map((product) => product.vbkAccount)), new Set(["vbk-0", "vbk-1", "vbk-2"]));
    assert.deepEqual(new Set(summaries.map((product) => product.revision)), new Set([1, 2, 3]));
    assert.equal(statements.filter((statement) => statement.includes("FROM local_product_state AS s JOIN products AS p")).length, 1);
    assert.equal(statements.filter((statement) => /messages|research_tasks|automation_runs/.test(statement)).length, 0);
  } finally {
    db.close();
  }
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-local-state-"));
  const db = new VbkDatabase(root);
  const store = createAppAuthStore(path.join(root, "session.json"));
  const login = (id: number) => store.set({ token: `token-${id}`, expiresAt: "2099-01-01",
    user: { id, name: `用户${id}`, phone: `phone-${id}`, status: "active", expiresAt: "2099-01-01" } });
  login(1);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, store, login };
}

test("空本机列表仍完成一次历史迁移，并按当前账号返回摘要", async (t) => {
  const { db, store } = fixture(t);
  const remote = db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  let reads = 0;
  const service = createLocalProductService({ db, store, capture() {}, legacy: {
    async list() { reads++; return [remote]; },
    async get() { reads++; return { ...remote, vbkAccount: "historical-account" }; },
  } });
  const listed = await service.list();
  assert.equal(reads, 2);
  assert.deepEqual(listed.map((product) => product.id), [remote.id]);
  assert.equal(listed[0].vbkAccount, "historical-account");
  assert.equal(listed[0].revision, 1);
});

test("删除在同一产品事务中清理归属，允许另一账号以相同 ID 重存", async (t) => {
  const { db, store, login } = fixture(t);
  const service = createLocalProductService({ db, store, capture() {} });
  const snapshot = db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  await service.upsert(snapshot);
  await service.delete(snapshot.id);
  assert.equal(db.readLocalProductState(snapshot.id), undefined);
  assert.equal(db.getProduct(snapshot.id), undefined);
  login(2);
  const restored = await service.upsert({ ...snapshot, name: "新账号重新保存" });
  assert.equal(restored.name, "新账号重新保存");
  assert.equal(db.readLocalProductState(snapshot.id)?.ownerUserId, 2);
});

test("活动产品仍被删除门拦截，归属状态不会提前清理", async (t) => {
  const { db, store } = fixture(t);
  const service = createLocalProductService({ db, store, capture() {} });
  const product = await service.upsert(db.buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" }));
  db.updateProduct(product.id, product.product, "automating", product.productJsonVersion);
  await assert.rejects(service.delete(product.id), /正在自动录入/);
  assert.equal(db.readLocalProductState(product.id)?.ownerUserId, 1);
  assert.equal(db.getProduct(product.id)?.status, "automating");
});
