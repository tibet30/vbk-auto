import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";
import { defaultCommercialInventory } from "../../src/main/data/commercial-defaults.js";

// ───────────────────────── helpers ─────────────────────────

async function makeDb(): Promise<{ db: VbkDatabase; cleanup: () => void }> {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-test-open-json-"));
  const db = new VbkDatabase(dataPath);
  return {
    db,
    cleanup: () => {
      try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function makeValidProjectJson(): string {
  // 必须满足 productSchema：包含 basicInfo + sales + operations + itinerary
  return JSON.stringify({
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原 2 天 1 晚私家团",
      supplierProductCode: "VBK-20260803-AAAAAA",
      subtitle: "轻松慢游",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西省",
      operationNotes: "VIP 专车服务",
    },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地4钻酒店/-4", mealsIncluded: false, pickupCity: "太原", transport: "charter", reusePickupForDropoff: true },
    itinerary: [
      {
        day: 1,
        title: "D1 太原接站",
        spots: [{ name: "晋祠", poiName: "晋祠", poiId: 79413 }],
        description: "专车接站后游览晋祠。",
        hotel: "太原市区酒店",
        meals: "敬请自理",
      },
      {
        day: 2,
        title: "D2 太原送站",
        spots: [{ name: "蒙山大佛", poiName: "蒙山大佛", poiId: 105586 }],
        description: "专车送站。",
        hotel: "",
        meals: "敬请自理",
      },
    ],
  });
}

/**
 * 复刻 main.ts 里 projects:updateProductJson 的 handler 逻辑：解析 → parseProduct → updateProduct。
 * 不直接调 ipcMain.handle，而是验证底层流程与 IPC 端完全等价。
 */
async function updateProductJsonLikeIpc(db: VbkDatabase, id: string, json: string) {
  const project = db.getProject(id);
  if (!project) throw new Error("项目不存在");
  let next: Record<string, unknown>;
  try { next = JSON.parse(json); }
  catch { throw new Error("产品 JSON 无法解析，请检查格式。"); }
  parseProduct(next);
  db.updateProduct(id, next, "review");
  return db.getProject(id)!;
}

// ───────────────────────── 测试 ─────────────────────────

test("合法 JSON 写入：product 落库 + project.status='review'", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
    const updated = await updateProductJsonLikeIpc(db, project.id, makeValidProjectJson());

    assert.equal(updated.status, "review");
    assert.equal((updated.product.basicInfo as Record<string, unknown>).subtitle, "轻松慢游");
    assert.equal(updated.product.itinerary.length, 2);
  } finally { cleanup(); }
});

test("非法 JSON 抛错：try/catch 抛「产品 JSON 无法解析」", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
    await assert.rejects(
      async () => updateProductJsonLikeIpc(db, project.id, "{ broken json"),
      /产品 JSON 无法解析/,
    );
  } finally { cleanup(); }
});

test("产品协议被违反抛错：缺 basicInfo.meetingCity", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
    const broken = JSON.parse(makeValidProjectJson()) as Record<string, unknown>;
    const basic = broken.basicInfo as Record<string, unknown>;
    delete basic.meetingCity;
    await assert.rejects(
      async () => updateProductJsonLikeIpc(db, project.id, JSON.stringify(broken)),
      // zod 的 issue 信息，不强制字面量，只要报错即可
      (err: Error) => err instanceof Error,
    );
  } finally { cleanup(); }
});

test("项目不存在抛错", async () => {
  const { db, cleanup } = await makeDb();
  try {
    await assert.rejects(
      async () => updateProductJsonLikeIpc(db, "non-existent-id", makeValidProjectJson()),
      /项目不存在/,
    );
  } finally { cleanup(); }
});

test("空对象 JSON 被协议拒绝：parseProduct 拒绝整个对象", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
    await assert.rejects(
      async () => updateProductJsonLikeIpc(db, project.id, JSON.stringify({ random: "field" })),
      (err: Error) => err instanceof Error,
    );
  } finally { cleanup(); }
});

test("updateProductJson 成功后原项目里旧 product 字段被覆盖", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
    assert.equal((project.product.basicInfo as Record<string, unknown>).subtitle, "");
    assert.deepEqual(project.product.commercial, { inventory: defaultCommercialInventory() });

    const next = JSON.parse(makeValidProjectJson()) as Record<string, unknown>;
    (next.basicInfo as Record<string, unknown>).subtitle = "更新后的副标题";
    await updateProductJsonLikeIpc(db, project.id, JSON.stringify(next));

    const reloaded = db.getProject(project.id)!;
    assert.equal((reloaded.product.basicInfo as Record<string, unknown>).subtitle, "更新后的副标题");
    assert.equal(reloaded.product.commercial, undefined);
  } finally { cleanup(); }
});
