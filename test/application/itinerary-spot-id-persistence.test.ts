import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { approvedPlanVersion } from "../../src/main/application/product-approval-projection.js";
import { itinerarySpotIdMigration } from "../../src/main/infrastructure/database/parts/itinerary-spot-id-migration.js";
import { isItinerarySpotId } from "../../src/shared/itinerary-spot-identity.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

type Json = Record<string, unknown>;

function setup(context: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-spot-id-"));
  const db = new VbkDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const created = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
  return { db, id: created.id, created, raw: (db as unknown as { db: Database.Database }).db };
}

function itinerary(): Json[] {
  return [
    { day: 1, title: "D1 潮州", description: "游览古城。", hotel: "潮州市区酒店", meals: "敬请自理",
      spots: [{ name: "广济桥" }, { name: "牌坊街" }] },
    { day: 2, title: "D2 潮州", description: "送站。", hotel: "", meals: "敬请自理",
      spots: [{ name: "开元寺" }] },
  ];
}

function spotsOf(product: Json): Json[] {
  return (product.itinerary as Json[]).flatMap(day => (day.spots as Json[]) ?? []);
}

function idsOf(product: Json): unknown[] {
  return spotsOf(product).map(spot => spot.spotId);
}

function assertAllValid(product: Json) {
  const ids = idsOf(product);
  assert.ok(ids.length > 0);
  assert.ok(ids.every(isItinerarySpotId), `存在非法 spotId: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length);
}

test("replace 后每个景点都有合法 spotId", (t) => {
  const { db, id, created } = setup(t);
  const saved = new ProductMutationService(db).replace(id, { ...created.product, itinerary: itinerary() });
  assertAllValid(saved.product as Json);
  assertAllValid(db.getProduct(id)!.plan as Json);
});

test("关闭 POI 保留的整包编辑同样补 spotId", (t) => {
  const { db, id, created } = setup(t);
  const saved = new ProductMutationService(db).replace(id, { ...created.product, itinerary: itinerary() },
    { preserveVerifiedItineraryPois: false });
  assertAllValid(saved.product as Json);
});

test("模型重生成整份行程（不带 ID）后同名景点 ID 不变", (t) => {
  const { db, id, created } = setup(t);
  const service = new ProductMutationService(db);
  const first = service.replace(id, { ...created.product, itinerary: itinerary() });
  const before = idsOf(first.product as Json);
  const regenerated = itinerary();
  (regenerated[0].spots as Json[]).push({ name: "韩文公祠" });
  const second = service.replace(id, { ...first.product, itinerary: regenerated });
  const after = idsOf(second.product as Json);
  assert.deepEqual([after[0], after[1], after[3]], before);
  assert.ok(isItinerarySpotId(after[2]));
  assert.ok(!before.includes(after[2]));
});

test("迁移补 ID 不改版本号，已批准审批仍有效", (t) => {
  const { db, id, created, raw } = setup(t);
  new ProductMutationService(db).replace(id, { ...created.product, itinerary: itinerary() });
  // 模拟存量数据：直接把库里的 plan 改回没有 spotId 的旧形态。
  const plan = JSON.parse((raw.prepare("SELECT product_json FROM products WHERE id=?").get(id) as { product_json: string }).product_json) as Json;
  for (const spot of spotsOf(plan)) delete spot.spotId;
  raw.prepare("UPDATE products SET product_json=? WHERE id=?").run(JSON.stringify(plan), id);
  const legacy = db.getProduct(id)!;
  assert.ok(idsOf(legacy.product as Json).every(spotId => spotId === undefined));
  const approval = { id: "approval", status: "approved", productVersion: approvedPlanVersion(legacy),
    accountKey: "account", scope: [], summary: "确认", createdAt: "now" };
  db.saveAgentSnapshot({ localProductId: id, events: [],
    run: { id: "run", status: "paused", createdAt: "now", updatedAt: "now" },
    approval } as unknown as AgentSnapshot);
  const versions = () => raw.prepare("SELECT product_json_version,plan_version FROM products WHERE id=?").get(id);
  const versionsBefore = versions();

  raw.transaction(() => itinerarySpotIdMigration.migrate!(raw))();

  assert.deepEqual(versions(), versionsBefore);
  const migrated = db.getProduct(id)!;
  assertAllValid(migrated.plan as Json);
  assertAllValid(migrated.product as Json);
  assert.equal(approvedPlanVersion(migrated), approval.productVersion);
  assert.equal(itinerarySpotIdMigration.id, "0019_itinerary_spot_id");
});

test("迁移跳过无法解析的产品行，不阻断启动", (t) => {
  const { db, id, raw } = setup(t);
  raw.prepare("UPDATE products SET product_json=? WHERE id=?").run("{坏数据", id);
  assert.doesNotThrow(() => raw.transaction(() => itinerarySpotIdMigration.migrate!(raw))());
  assert.equal((raw.prepare("SELECT product_json FROM products WHERE id=?").get(id) as { product_json: string }).product_json, "{坏数据");
  void db;
});

test("导入远端快照继承本地 ID，内容相同不递增版本", (t) => {
  const { db, id, created } = setup(t);
  const saved = new ProductMutationService(db).replace(id, { ...created.product, itinerary: itinerary() });
  // 先导入一次带 ID 的快照，让本地 plan 经过导入归一化；之后的比较只反映 spotId 的差异。
  const local = db.importProductSnapshot(saved);
  const localIds = idsOf(local.product as Json);
  const remoteProduct = structuredClone(local.product) as Json;
  for (const spot of spotsOf(remoteProduct)) delete spot.spotId;
  const imported = db.importProductSnapshot({ ...local, product: remoteProduct as ProductDetail["product"] });
  assert.deepEqual(idsOf(imported.product as Json), localIds);
  assert.equal(imported.planVersion, local.planVersion);
  assert.equal(imported.productJsonVersion, local.productJsonVersion);
});

test("导入全新远端快照也补齐 spotId", (t) => {
  const { db, created } = setup(t);
  const fresh = { ...created, id: "remote-new", product: { ...created.product, itinerary: itinerary() } as ProductDetail["product"] };
  const imported = db.importProductSnapshot(fresh);
  assertAllValid(imported.product as Json);
});
