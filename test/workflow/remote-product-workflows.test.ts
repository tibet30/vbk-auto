import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import type { TibetProductService } from "../../src/main/infrastructure/tibet-products.js";
import {
  createRemoteProduct,
  getRemoteProduct,
  listRemoteProducts,
} from "../../src/main/application/remote-product-workflows.js";
import type { ProductDetail, ProductSummary } from "../../src/shared/contracts.js";

async function database(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-remote-product-workflows-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new VbkDatabase(root);
}

function fakeRemote(initial: ProductDetail[] = []) {
  const records = new Map(initial.map((product) => [product.id, product]));
  const calls = { upsert: 0 };
  const service: TibetProductService = {
    async list(): Promise<ProductSummary[]> {
      return [...records.values()].map(({ id, name, status, productId, updatedAt }) => ({ id, name, status, productId, updatedAt }));
    },
    async upsert(product) { calls.upsert += 1; records.set(product.id, product); return product; },
    async update(product) { records.set(product.id, product); return product; },
    async get(id) { const found = records.get(id); if (!found) throw new Error("not found"); return found; },
    async delete(id) { records.delete(id); },
  };
  return { service, records, calls };
}

test("产品列表只读取 Tibet，不把本地产品上传到远端", async (t) => {
  const db = await database(t);
  const local = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const remote = fakeRemote();
  const first = await listRemoteProducts(remote.service);
  const second = await listRemoteProducts(remote.service);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(remote.calls.upsert, 0);
});

test("远端创建失败时不写本地产品，不留下半成品", async (t) => {
  const db = await database(t);
  const remote = fakeRemote();
  remote.service.upsert = async () => { throw new Error("Tibet unavailable"); };
  await assert.rejects(
    createRemoteProduct(db, remote.service, { destination: "太原", days: 2, productForm: "privateTour" }, null),
    /Tibet unavailable/,
  );
  assert.deepEqual(db.listProducts(), []);
});

test("产品列表不会把远端快照写回本地缓存", async (t) => {
  const db = await database(t);
  const local = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const newer = {
    ...local,
    name: "远端更新后的名称",
    updatedAt: "2099-08-20T10:00:00.000Z",
  };
  const remote = fakeRemote([newer]);
  await listRemoteProducts(remote.service);
  assert.equal(db.getProduct(local.id)?.name, local.name);
  assert.equal(remote.calls.upsert, 0);
});

test("Tibet 详情作为权威快照恢复运行缓存的原 UUID 和消息", async (t) => {
  const source = await database(t);
  const created = source.createProduct({ destination: "拉萨", days: 3, productForm: "privateTour" });
  const target = await database(t);
  const remote = fakeRemote([created]);
  const restored = await getRemoteProduct(target, remote.service, created.id);
  assert.equal(restored.id, created.id);
  assert.equal(restored.name, created.name);
  assert.equal(restored.messages.length, 1);
  assert.equal(target.getProduct(created.id)?.id, created.id);
});

test("创建只保存原始目的地，不调用目的地解析接口", async (t) => {
  const db = await database(t);
  const remote = fakeRemote();
  const created = await createRemoteProduct(db, remote.service, { destination: "西藏自治区", days: 3, productForm: "privateTour" }, null);
  const basic = created.product.product.basicInfo as Record<string, unknown>;
  assert.equal(basic.destination, "西藏自治区");
  assert.equal(basic.destinationCity, "西藏自治区");
  assert.equal(basic.province, "");
  assert.equal(remote.calls.upsert, 1);
});
