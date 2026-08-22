import assert from "node:assert/strict";
import test from "node:test";
import type { ProductDetail } from "../../src/shared/contracts.js";
import { getProductForRead } from "../../src/main/application/remote-product-workflows.js";
import type { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import type { TibetProductService } from "../../src/main/infrastructure/tibet-products.js";

function product(id: string, fields: Record<string, unknown>): ProductDetail {
  return {
    id,
    name: "测试产品",
    status: "planning",
    updatedAt: "2026-08-22T00:00:00.000Z",
    product: fields,
    messages: [],
    researchTasks: [],
  };
}

test("active workflow 下 products:get 返回本地快照，不调用 remote 或 import", async () => {
  const local = product("p-1", {
    packageName: "本地新套餐",
    pricing: { adult: 999 },
    inventory: { seats: 12 },
  });
  const remote = product("p-1", {
    inventory: { seats: 1 },
    release: { state: "old" },
  });
  let remoteReads = 0;
  let imports = 0;
  const db = {
    getProduct: (id: string) => id === local.id ? local : undefined,
    importProductSnapshot: () => { imports += 1; return remote; },
  } as unknown as VbkDatabase;
  const remoteProducts = {
    get: async () => { remoteReads += 1; return remote; },
  } as unknown as TibetProductService;

  const result = await getProductForRead(db, remoteProducts, local.id, "planning");

  assert.equal(result.product.packageName, "本地新套餐");
  assert.deepEqual(result.product.pricing, { adult: 999 });
  assert.deepEqual(result.product.inventory, { seats: 12 });
  assert.equal(remoteReads, 0);
  assert.equal(imports, 0);
});

test("idle 时 products:get 仍读取远端并导入本地缓存", async () => {
  const local = product("p-2", { packageName: "本地旧套餐" });
  const remote = product("p-2", { packageName: "远端权威套餐", release: { state: "ready" } });
  let remoteReads = 0;
  let imports = 0;
  const db = {
    getProduct: () => local,
    importProductSnapshot: (snapshot: ProductDetail) => { imports += 1; return snapshot; },
  } as unknown as VbkDatabase;
  const remoteProducts = {
    get: async () => { remoteReads += 1; return remote; },
  } as unknown as TibetProductService;

  const result = await getProductForRead(db, remoteProducts, local.id);

  assert.equal(result.product.packageName, "远端权威套餐");
  assert.deepEqual(result.product.release, { state: "ready" });
  assert.equal(remoteReads, 1);
  assert.equal(imports, 1);
});

test("active workflow 下本地快照不存在时明确报产品不存在", async () => {
  const db = { getProduct: () => undefined } as unknown as VbkDatabase;
  const remoteProducts = { get: async () => { throw new Error("remote must not be called"); } } as unknown as TibetProductService;

  await assert.rejects(
    getProductForRead(db, remoteProducts, "missing", "automation"),
    (error: unknown) => error instanceof Error && error.message === "产品不存在：missing",
  );
});
