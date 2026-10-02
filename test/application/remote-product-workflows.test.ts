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
  const remote = { ...product("p-2", { packageName: "远端权威套餐", release: { state: "ready" } }), updatedAt: "2026-08-22T00:00:01.000Z" };
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

test("idle 详情读取不让旧 failed automation 覆盖较新的本机价格和酒店运行态", async () => {
  const local = {
    ...product("p-3", { pricing: { adult: 3680 }, hotelCandidates: ["有熊酒店"] }),
    updatedAt: "2026-09-30T14:00:00.000Z",
    automation: {
      id: "new-run", status: "running", phases: [
        { phase: "pricingInventory", status: "completed" },
        { phase: "hotelResource", status: "completed" },
      ], logs: [],
    },
  } as ProductDetail;
  const remote = {
    ...product("p-3", { itinerary: [] }),
    updatedAt: "2026-09-30T13:53:41.424Z",
    automation: { id: "old-run", status: "failed", phases: [{ phase: "itinerary", status: "failed" }], logs: [] },
  } as ProductDetail;
  let imports = 0;
  const db = {
    getProduct: () => local,
    importProductSnapshot: () => { imports += 1; return remote; },
  } as unknown as VbkDatabase;
  const remoteProducts = { get: async () => remote } as unknown as TibetProductService;

  const result = await getProductForRead(db, remoteProducts, local.id);

  assert.equal(result, local);
  assert.equal(result.automation?.id, "new-run");
  assert.deepEqual(result.product.pricing, { adult: 3680 });
  assert.equal(imports, 0);
});

test("idle 详情读取遇到相等或无效时间时 fail-safe 保留本机快照", async () => {
  const local = product("p-4", { packageName: "本机运行态" });
  const remote = { ...product("p-4", { packageName: "远端旧快照" }) };
  let imports = 0;
  const db = {
    getProduct: () => local,
    importProductSnapshot: (snapshot: ProductDetail) => { imports += 1; return snapshot; },
  } as unknown as VbkDatabase;
  const remoteProducts = { get: async () => remote } as unknown as TibetProductService;

  assert.equal(await getProductForRead(db, remoteProducts, local.id), local);
  remote.updatedAt = "invalid";
  assert.equal(await getProductForRead(db, remoteProducts, local.id), local);
  local.updatedAt = "invalid";
  assert.equal(await getProductForRead(db, remoteProducts, local.id), local);
  assert.equal(imports, 0);
});

test("远端详情请求期间本机更新时以返回后的最新本机快照为准", async () => {
  let local = { ...product("p-race", { packageName: "08:00 本机状态" }), updatedAt: "2026-10-01T08:00:00.000Z" };
  const newestLocal = { ...local, product: { packageName: "09:00 本机状态" }, updatedAt: "2026-10-01T09:00:00.000Z" };
  const remote = { ...product("p-race", { packageName: "08:30 远端状态" }), updatedAt: "2026-10-01T08:30:00.000Z" };
  let resolveRemote!: (value: ProductDetail) => void;
  let imports = 0;
  const db = {
    getProduct: () => local,
    importProductSnapshot: (snapshot: ProductDetail) => { imports += 1; return snapshot; },
  } as unknown as VbkDatabase;
  const remoteProducts = {
    get: async () => new Promise<ProductDetail>((resolve) => { resolveRemote = resolve; }),
  } as unknown as TibetProductService;

  const pending = getProductForRead(db, remoteProducts, local.id);
  local = newestLocal;
  resolveRemote(remote);

  assert.equal(await pending, newestLocal);
  assert.equal(imports, 0);
});

test("请求期间本机新工作流即使远端更新时间更晚也不能被覆盖", async () => {
  let local = { ...product("p-race-newer", { packageName: "08:00 本机状态" }), updatedAt: "2026-10-01T08:00:00.000Z" };
  const newestLocal = { ...local, status: "automating" as const, updatedAt: "2026-10-01T09:00:00.000Z" };
  const remote = { ...product("p-race-newer", { packageName: "10:00 远端状态" }), updatedAt: "2026-10-01T10:00:00.000Z" };
  let resolveRemote!: (value: ProductDetail) => void;
  let imports = 0;
  const db = {
    getProduct: () => local,
    importProductSnapshot: (snapshot: ProductDetail) => { imports += 1; return snapshot; },
  } as unknown as VbkDatabase;
  const remoteProducts = {
    get: async () => new Promise<ProductDetail>((resolve) => { resolveRemote = resolve; }),
  } as unknown as TibetProductService;

  const pending = getProductForRead(db, remoteProducts, local.id);
  local = newestLocal;
  resolveRemote(remote);

  assert.equal(await pending, newestLocal);
  assert.equal(imports, 0);
});

test("本机不存在时仍导入远端详情", async () => {
  const remote = product("p-5", { packageName: "远端产品" });
  let imports = 0;
  const db = {
    getProduct: () => undefined,
    importProductSnapshot: (snapshot: ProductDetail) => { imports += 1; return snapshot; },
  } as unknown as VbkDatabase;
  const remoteProducts = { get: async () => remote } as unknown as TibetProductService;

  assert.equal(await getProductForRead(db, remoteProducts, remote.id), remote);
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
