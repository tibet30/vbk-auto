import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../../src/main/infrastructure/database/database.js";

// ───────────── helpers ─────────────

export function makeDb(): { db: VbkDatabase; cleanup: () => void; dataPath: string } {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-replace-and-satisfy-"));
  const db = new VbkDatabase(dataPath);
  return {
    db,
    dataPath,
    cleanup: () => {
      try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export function seedTaiyuanProductWithTasks(db: VbkDatabase) {
  // 用真实回归证据中的 2 天 1 晚私家团 + 钟楼街 + 食品街。
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  // 把 itinerary 写成"已含钟楼街 spot 但 poiName/poiId 仍空"——这是真实回归
  // 里 AI 第一次出第一版时的常见形态。
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [
      {
        day: 1,
        title: "D1 太原老城",
        spots: [
          { name: "太原食品街", poiName: null, poiId: null },
          { name: "晋祠", poiName: "晋祠博物馆", poiId: 79413 },
        ],
        description: "首日：探访钟楼街与食品街。",
        hotel: "太原市区酒店",
        meals: "敬请自理",
      },
      {
        day: 2,
        title: "D2 晋祠",
        spots: [{ name: "晋祠", poiName: "晋祠博物馆", poiId: 79413 }],
        description: "次日：游览晋祠。",
        hotel: "",
        meals: "敬请自理",
      },
    ],
    // presentation 初始为空对象；由「保存 cover」的测试用例自己填。
    presentation: {},
  });
  // AI 第一次出第一版时同时往 research_tasks 落了同名 POI 核查 + 封面图。
  const poiTask = db.addResearchTask(product.id, {
    label: "核查 钟楼街 的 VBK POI 映射",
    type: "vbk",
    detail: "钟楼街是太原食品街的别称/片区",
  });
  const coverTask = db.addResearchTask(product.id, {
    label: "获取产品封面图",
    type: "image",
    detail: "POI 钟楼街；描述：横版；最低质量 3。",
  });
  // 顺带再加一条「不相关 POI 核查」用于反例：保留 食品街 的另一条 task
  // （不要求去满足，仅用于验证 strict matching 不会误伤）。
  const unrelatedPoiTask = db.addResearchTask(product.id, {
    label: "核查 食品街 的 VBK POI 映射",
    type: "vbk",
    detail: "食品街主体",
  });
  // 已先被前序流程写齐 vehicle / hotel 字段；vehicle/hotel 任务本应已被
  // 自动满足——这条 task 用来验证「已满足的 task 也被一并确认」，避免
  // 漏掉 vehicle / hotel 维度。
  db.updateProduct(product.id, {
    ...db.getProduct(product.id)!.product,
    operations: {
      ...(db.getProduct(product.id)!.product.operations as Record<string, unknown> ?? {}),
      hotelTier: "当地4钻酒店/-4",
      vehicleResource: { resourceGroupId: 88231, resourceGroupName: "太原用车组" },
    },
  });
  const vehicleTask = db.addResearchTask(product.id, {
    label: "核查用车资源组（按目的地 / 出行人数）",
    type: "vbk",
    detail: "太原",
  });
  const hotelTask = db.addResearchTask(product.id, {
    label: "核查酒店资源",
    type: "vbk",
    detail: "太原 4 钻",
  });
  // 一条「运营主动录入但仍 queued」的 task：日程里并没有 食品街 完整 POI 字段，
  // 不应被这次写入误确认。
  const poiTaskNotSatisfied = db.addResearchTask(product.id, {
    label: "核查 食品街（北门） 的 VBK POI 映射",
    type: "vbk",
    detail: "北门入口",
  });
  return { product, poiTask, coverTask, unrelatedPoiTask, vehicleTask, hotelTask, poiTaskNotSatisfied };
}
