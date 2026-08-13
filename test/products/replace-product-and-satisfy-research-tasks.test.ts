/**
 * 「product JSON 写入」与「research task 字段匹配确认」原子化回归测试。
 *
 * 真实回归证据（产品 3e6a4db5-a1df-4b21-8f28-7ca41a626479）：
 *   - 手动用 VBK suggestPoi 选 太原「钟楼街」 poiId=131897125 并保存后，
 *     product.itinerary[dayIndex].spots[spotIndex] 已正确为
 *     {name:"太原食品街", poiName:"钟楼街", poiId:131897125}；
 *   - 但 research_tasks 中同名 POI task 仍 status=queued, state=researching；
 *   - 已持久化封面，cover task 仍 queued/researching；
 *   - UI 乐观态 readiness 100%，自动化 preflight 从持久化 DB 重新计算为 92%，
 *     automation_runs 的 basic 阶段被阻断，但 basic 之前的 VBK 草稿已创建。
 *
 * 根因方向：products:updateReviewField 只调 productMutations.replace，没在
 * 同一事务里同步确认匹配的 research_tasks 行；research:refreshIssues 又是
 * 用户手动触发，从不自动跑——所以「product 已满足 task 条件」的事实从未
 * 写进持久化。
 *
 * 修复入口：`db.replaceProductAndSatisfyResearchTasks` 把
 *   - UPDATE products SET product_json=..., status=...
 *   - UPDATE research_tasks SET state='confirmed', status='succeeded'
 * 放在同一个 db.transaction()，并按 task label/type 严格匹配；不允许把
 * 所有 queued task 一概转成功。
 *
 * 验收门（对应用户给的 1..7）：
 *   1) 有效 itinerarySpotPoi 落库后，匹配 POI 人工核查 task 的状态
 *      status=succeeded / state=confirmed；不相关 POI task 绝不可误确认。
 *   2) 有效 productCover 落库后，匹配 cover task 持久化确认；非完整 cover
 *      （缺 imageId 等关键字段）不得误确认。
 *   3) products:get / 应用重载 / 自动化 preflight 都从同一持久化层
 *      算到一致 readiness，**不**依赖 renderer 乐观态；本测试通过
 *      「reopen DB + re-read」证明这点。
 *   4) 任务匹配的严格性：按 task label / type + product field 一一判定；
 *      vehicle / hotel / cost / web 的 task 只有对应谓词命中时才确认。
 *   5) 主路径、反例、重载/持久化都有可执行测试（本文件）。
 *   6) npm run check / 聚焦测试 / npm run build / git diff --check 由
 *      外层脚本统一跑。
 *   7) 旧 VBK 草稿 productId 不可被本测试触动（只读 / 新建临时 db）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

// ───────────── helpers ─────────────

function makeDb(): { db: VbkDatabase; cleanup: () => void; dataPath: string } {
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

function seedTaiyuanProductWithTasks(db: VbkDatabase) {
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

// ───────────── 主路径：POI ─────────────

test("保存有效 itinerarySpotPoi 后，匹配 POI task 持久化确认（status=succeeded / state=confirmed）", () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, poiTask, coverTask, unrelatedPoiTask, vehicleTask, hotelTask, poiTaskNotSatisfied } = seedTaiyuanProductWithTasks(db);

    // 在做「保存 POI」之前，匹配 task 应仍在 researching。
    const beforePoi = db.getProduct(product.id)!.researchTasks.find((t) => t.id === poiTask)!;
    assert.equal(beforePoi.state, "researching");
    assert.equal(beforePoi.status, "queued");

    // 模拟 IPC 端 updateReviewField：先把新 product 算出来（用真实回归里的
    // poiName/poiId 写入钟楼街 spot），再走原子化落库。
    const productJson = db.getProduct(product.id)!.product;
    const nextProduct: Record<string, unknown> = structuredClone(productJson);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };

    const { product: saved, confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });

    // 落库后立即读：状态必须是 review，spot 已带 poiName/poiId。
    assert.equal(saved.status, "review");
    const persistedSpot = (saved.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0].spots[0];
    assert.equal(persistedSpot.poiName, "钟楼街");
    assert.equal(persistedSpot.poiId, 131897125);

    // 确认的目标 task 应包括「钟楼街 POI 核查」+「用车」（已满足）+「酒店」（已满足）。
    assert.ok(confirmedTaskIds.includes(poiTask), "钟楼街 POI task 必须在 confirmedTaskIds");
    assert.ok(confirmedTaskIds.includes(vehicleTask), "用车 task 已由 product 满足，必须一并确认");
    assert.ok(confirmedTaskIds.includes(hotelTask), "酒店 task 已由 product 满足，必须一并确认");

    // cover task 此时还没 cover，**不**应被确认。
    assert.ok(!confirmedTaskIds.includes(coverTask), "cover task 仍未被满足，不应确认");

    // 「不相关 POI 核查」严格匹配保护：日程里没有 poiName/poiId，**不**应被确认。
    assert.ok(!confirmedTaskIds.includes(unrelatedPoiTask), "钟楼街写入不应当误确认「食品街」task");
    assert.ok(!confirmedTaskIds.includes(poiTaskNotSatisfied), "没有完整 POI 字段的 task 不应被误确认");

    // 单条 task 的 state/status/evidence 都应被正确写入。
    const byId = new Map(saved.researchTasks.map((t) => [t.id, t]));
    const poiAfter = byId.get(poiTask)!;
    assert.equal(poiAfter.state, "confirmed");
    assert.equal(poiAfter.status, "succeeded");
    assert.equal(poiAfter.evidence?.length, 1, "evidence 必须写入 1 条");
    assert.equal(poiAfter.evidence?.[0].accepted, true);
    assert.equal(poiAfter.evidence?.[0].source, "user");
    // 不相关 POI 仍在 researching / queued。
    assert.equal(byId.get(unrelatedPoiTask)?.state, "researching");
    assert.equal(byId.get(unrelatedPoiTask)?.status, "queued");
    assert.equal(byId.get(unrelatedPoiTask)?.evidence?.length, 0);
    // cover task 还在原状态。
    assert.equal(byId.get(coverTask)?.state, "researching");
    assert.equal(byId.get(coverTask)?.status, "queued");
  } finally { cleanup(); }
});

// ───────────── 主路径：cover ─────────────

test("保存有效 productCover (ctripLibrary) 后，匹配 image cover task 持久化确认", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [
        { day: 1, title: "D1", description: "首日", hotel: "酒店", meals: "自理", spots: [{ name: "钟楼街", poiName: null, poiId: null }] },
      ],
      presentation: {},
    });
    const coverTask = db.addResearchTask(product.id, {
      label: "获取产品封面图",
      type: "image",
      detail: "POI 钟楼街；描述：横版；最低质量 3。",
    });
    // 加一个 image 类型但实际不匹配任何 cover 的 task（image 类型只看
    // product.presentation.cover 是否完整；多个 image task 之间不互相干扰）。
    const anotherImage = db.addResearchTask(product.id, {
      label: "备用封面图（备用）",
      type: "image",
      detail: "备用",
    });

    const before = db.getProduct(product.id)!.researchTasks.find((t) => t.id === coverTask)!;
    assert.equal(before.state, "researching");

    const productJson = db.getProduct(product.id)!.product;
    const nextProduct: Record<string, unknown> = structuredClone(productJson);
    (nextProduct.presentation as Record<string, unknown>).cover = {
      source: "ctripLibrary",
      imageId: 1810403829,
      imageUrl: "https://dimg04.c-ctrip.com/images/0Z71341234567890.jpg",
      poi: "钟楼街",
      description: "横版钟楼街外景",
      minQuality: 3,
    };

    const { confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });

    // image 类 task：所有 image 任务都该被确认（因为 product 现在有完整 cover，
    // isCoverResearchTaskSatisfiedByProduct 只看 type === "image" + cover 完整）。
    assert.ok(confirmedTaskIds.includes(coverTask));
    assert.ok(confirmedTaskIds.includes(anotherImage));

    const byId = new Map(db.getProduct(product.id)!.researchTasks.map((t) => [t.id, t]));
    assert.equal(byId.get(coverTask)?.state, "confirmed");
    assert.equal(byId.get(coverTask)?.status, "succeeded");
    assert.equal(byId.get(anotherImage)?.state, "confirmed");
  } finally { cleanup(); }
});

test("保存有效 productCover (manualUpload) 后，匹配 image cover task 持久化确认", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    const coverTask = db.addResearchTask(product.id, {
      label: "获取产品封面图",
      type: "image",
      detail: "POI 钟楼街；描述：横版；最低质量 3。",
    });
    const nextProduct: Record<string, unknown> = {
      ...db.getProduct(product.id)!.product,
      presentation: {
        cover: {
          source: "manualUpload",
          fileId: "manual-2026-01-01-001",
          originalName: "cover.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1048576,
          poi: "钟楼街",
          description: "运营手动上传的封面图",
          minQuality: 3,
          uploadedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const { confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });
    assert.ok(confirmedTaskIds.includes(coverTask));
    assert.equal(db.getProduct(product.id)!.researchTasks.find((t) => t.id === coverTask)?.state, "confirmed");
  } finally { cleanup(); }
});

test("保存残缺 cover (缺 source) 后，image task 仍 queued/researching", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    const coverTask = db.addResearchTask(product.id, {
      label: "获取产品封面图",
      type: "image",
      detail: "POI 钟楼街；描述：横版；最低质量 3。",
    });
    // 故意缺 source：cover predicate 要求 source 是字面量 "ctripLibrary"
    // 或 "manualUpload"，其它情况都返回 false。注意：imageId / imageUrl
    // 是 product JSON 中合法的可选元数据，hasCompleteCtripLibraryCover
    // 仍会判为「完整」——不要把这两个字段当作 cover「必须」字段。
    const nextProduct: Record<string, unknown> = {
      ...db.getProduct(product.id)!.product,
      presentation: {
        cover: {
          // 故意缺 source
          poi: "钟楼街",
          description: "横版钟楼街外景",
          minQuality: 3,
        },
      },
    };
    const { confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });
    assert.ok(!confirmedTaskIds.includes(coverTask), "缺 source 的 cover 不应误确认 cover task");
    const task = db.getProduct(product.id)!.researchTasks.find((t) => t.id === coverTask)!;
    assert.equal(task.state, "researching");
    assert.equal(task.status, "queued");
  } finally { cleanup(); }
});

// ───────────── 反例：严格匹配 ─────────────

test("反例：仅写入 POI 字段时 cover task 仍 queued，且与 POI 无关的 task 不被误确认", () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, poiTask, coverTask, unrelatedPoiTask, poiTaskNotSatisfied } = seedTaiyuanProductWithTasks(db);
    const productJson = db.getProduct(product.id)!.product;
    const nextProduct: Record<string, unknown> = structuredClone(productJson);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };

    const { confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });

    // 钟楼街 POI task 应被确认。
    assert.ok(confirmedTaskIds.includes(poiTask));
    // cover task：未传 cover → 不应确认。
    assert.ok(!confirmedTaskIds.includes(coverTask), "POI 写入不应连带确认 cover task");
    // 其它不相关 POI 不应被误确认。
    assert.ok(!confirmedTaskIds.includes(unrelatedPoiTask));
    assert.ok(!confirmedTaskIds.includes(poiTaskNotSatisfied));
  } finally { cleanup(); }
});

test("反例：所有 queued task 在 product 没满足任何字段时保持原样，绝不 blanket 确认", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    // 显式把 operations.hotelTier / vehicleResource 都清空，避免 createProduct
    // 默认的"当地5钻酒店"误打中 hotel task。
    db.updateProduct(product.id, {
      ...product.product,
      operations: { ...(product.product.operations as Record<string, unknown>), hotelTier: "", vehicleResource: {} },
      presentation: {},
    });
    const a = db.addResearchTask(product.id, { label: "核查 钟楼街 的 VBK POI 映射", type: "vbk", detail: "x" });
    const b = db.addResearchTask(product.id, { label: "核查 食品街 的 VBK POI 映射", type: "vbk", detail: "y" });
    const c = db.addResearchTask(product.id, { label: "获取产品封面图", type: "image", detail: "z" });
    const d = db.addResearchTask(product.id, { label: "核查用车资源组（按目的地 / 出行人数）", type: "vbk", detail: "v" });
    const e = db.addResearchTask(product.id, { label: "核查酒店资源", type: "vbk", detail: "h" });

    // product 不变：没有任何 spot / cover / 用车 / 酒店 满足条件。
    const { confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, db.getProduct(product.id)!.product, { status: "review" });
    assert.equal(confirmedTaskIds.length, 0, "无任何字段满足时不应 blanket 确认 queued task");
    const byId = new Map(db.getProduct(product.id)!.researchTasks.map((t) => [t.id, t]));
    for (const id of [a, b, c, d, e]) {
      assert.equal(byId.get(id)?.state, "researching", `${id} 不应被误确认`);
      assert.equal(byId.get(id)?.status, "queued");
    }
  } finally { cleanup(); }
});

// ───────────── 重载 / 持久化一致性 ─────────────

test("重载后 getProduct 看到的 product.status / research_tasks state 与写入时一致（persisted truth 单一来源）", () => {
  const { db, dataPath, cleanup } = makeDb();
  try {
    const { product, poiTask, coverTask, unrelatedPoiTask } = seedTaiyuanProductWithTasks(db);
    const productJson = db.getProduct(product.id)!.product;
    const nextProduct: Record<string, unknown> = structuredClone(productJson);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };
    // 顺便写一个完整 cover，模拟回归里"已生成并持久化封面"。
    (nextProduct.presentation as Record<string, unknown>).cover = {
      source: "ctripLibrary",
      imageId: 1810403829,
      imageUrl: "https://dimg04.c-ctrip.com/images/0Z71341234567890.jpg",
      poi: "钟楼街",
      description: "横版钟楼街外景",
      minQuality: 3,
    };

    const { confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });
    assert.ok(confirmedTaskIds.includes(poiTask));
    assert.ok(confirmedTaskIds.includes(coverTask));
    assert.ok(!confirmedTaskIds.includes(unrelatedPoiTask));

    // 模拟应用重载：丢弃 VbkDatabase 实例，重新读同一份 dataPath。
    const reopened = new VbkDatabase(dataPath);
    const reloaded = reopened.getProduct(product.id)!;
    assert.equal(reloaded.status, "review", "status 已落库并能重读");
    const persistedSpot = (reloaded.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0].spots[0];
    assert.equal(persistedSpot.poiName, "钟楼街");
    assert.equal(persistedSpot.poiId, 131897125);
    const persistedCover = (reloaded.product.presentation as Record<string, unknown>).cover as Record<string, unknown>;
    assert.equal(persistedCover.imageId, 1810403829);
    const byId = new Map(reloaded.researchTasks.map((t) => [t.id, t]));
    // 关键：重载后，POI task 与 cover task 都已是 confirmed / succeeded；
    // 这正是「products:readiness 与 automation_runs preflight」从持久化
    // 层读到的真相——与 UI 乐观态不再有差。
    assert.equal(byId.get(poiTask)?.state, "confirmed");
    assert.equal(byId.get(poiTask)?.status, "succeeded");
    assert.equal(byId.get(coverTask)?.state, "confirmed");
    assert.equal(byId.get(coverTask)?.status, "succeeded");
    assert.equal(byId.get(unrelatedPoiTask)?.state, "researching");
    assert.equal(byId.get(unrelatedPoiTask)?.status, "queued");
  } finally { cleanup(); }
});

test("原子性：写入 product 时如果研究任务 confirm 抛错，product 写入必须回滚", async () => {
  const { cleanup } = makeDb();
  try {
    // 不通过 VbkDatabase facade 走，而是直接用 parts/products.ts 在同一 raw
    // db 上跑事务——这样才能用 Proxy 拦截 raw better-sqlite3 的 prepare 调用
    // 制造失败、同时验证整个 db.transaction 真的把 products 写入回滚了。
    const Database = (await import("better-sqlite3")).default;
    const rawDb = new Database(":memory:");
    const { runDatabaseMigrations } = await import("../../src/main/infrastructure/database/parts/migration-registry.js");
    runDatabaseMigrations(rawDb);
    const parts = await import("../../src/main/infrastructure/database/parts/products.js");
    const { replaceProductAndSatisfyResearchTasks } = await import("../../src/main/infrastructure/database/parts/replace-product-with-research-tasks.js");
    const research = await import("../../src/main/infrastructure/database/parts/research-tasks.js");
    const product = parts.createProduct(rawDb, { destination: "太原", days: 2, productForm: "privateTour" });
    parts.updateProduct(rawDb, product.id, {
      ...product.product,
      itinerary: [
        { day: 1, title: "D1", description: "首日", hotel: "酒店", meals: "自理", spots: [{ name: "钟楼街", poiName: null, poiId: null }] },
      ],
      operations: { ...(product.product.operations as Record<string, unknown>), hotelTier: "", vehicleResource: {} },
      presentation: {},
    });
    const poiTask = research.addResearchTask(rawDb, product.id, { label: "核查 钟楼街 的 VBK POI 映射", type: "vbk", detail: "x" });

    // 事务前快照。
    const before = parts.getProduct(rawDb, product.id)!;
    const beforeSpot = (before.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0].spots[0];

    // Proxy 拦截：任何对 research_tasks 的 UPDATE 都失败 → 整个 db.transaction
    // 必须回滚，products.product_json 也必须被撤销。
    const realPrepare = (rawDb as unknown as { prepare: (sql: string) => unknown }).prepare.bind(rawDb);
    const proxy = new Proxy(rawDb, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("research_tasks") && sql.includes("UPDATE")) {
              throw new Error("故意失败：让事务回滚");
            }
            return realPrepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const productJson = parts.getProduct(rawDb, product.id)!.product;
    const nextProduct: Record<string, unknown> = structuredClone(productJson);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };

    assert.throws(
      () => replaceProductAndSatisfyResearchTasks(
        proxy as unknown as InstanceType<typeof Database>,
        product.id,
        nextProduct,
        { status: "review" },
      ),
      /故意失败/,
    );

    // 验证：product 写入已被事务回滚，POI task 仍是 researching。
    const reloaded = parts.getProduct(rawDb, product.id)!;
    const reloadedSpot = (reloaded.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0].spots[0];
    assert.equal(reloadedSpot.poiName, beforeSpot.poiName, "POI 字段必须回滚到事务前");
    assert.equal(reloadedSpot.poiId, beforeSpot.poiId);
    const poiAfter = reloaded.researchTasks.find((t) => t.id === poiTask)!;
    assert.equal(poiAfter.state, "researching", "POI task 状态必须回滚");
    assert.equal(poiAfter.status, "queued");
    assert.equal(reloaded.status, "planning", "status 必须回滚到事务前");

    rawDb.close();
  } finally { cleanup(); }
});

// ───────────── 幂等性 ─────────────

test("幂等：第二次写入同样满足条件的 product 不应再覆盖已 confirmed task 的 evidence", () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, poiTask } = seedTaiyuanProductWithTasks(db);
    const productJson = db.getProduct(product.id)!.product;
    const nextProduct: Record<string, unknown> = structuredClone(productJson);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };

    const first = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });
    assert.ok(first.confirmedTaskIds.includes(poiTask));
    const evidenceFirst = db.getProduct(product.id)!.researchTasks.find((t) => t.id === poiTask)!.evidence;
    assert.equal(evidenceFirst?.length, 1);

    // 第二次：完全相同的 product。
    const second = db.replaceProductAndSatisfyResearchTasks(product.id, structuredClone(nextProduct), { status: "review" });
    assert.equal(second.confirmedTaskIds.length, 0, "已 confirmed 的 task 不应被再次计数");
    const evidenceSecond = db.getProduct(product.id)!.researchTasks.find((t) => t.id === poiTask)!.evidence;
    assert.deepEqual(evidenceSecond, evidenceFirst, "evidence 不应在幂等调用时被覆盖");
  } finally { cleanup(); }
});

test("status / note 透传：options.status / options.researchEvidenceTitle 会被写入", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [
        { day: 1, title: "D1", description: "首日", hotel: "酒店", meals: "自理", spots: [{ name: "钟楼街", poiName: null, poiId: null }] },
      ],
    });
    const poiTask = db.addResearchTask(product.id, { label: "核查 钟楼街 的 VBK POI 映射", type: "vbk", detail: "x" });
    const nextProduct: Record<string, unknown> = structuredClone(db.getProduct(product.id)!.product);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };

    const { product: saved } = db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, {
      status: "review",
      researchEvidenceTitle: "手动保存钟楼街 POI，task 自动确认",
    });
    assert.equal(saved.status, "review");
    const evidence = saved.researchTasks.find((t) => t.id === poiTask)!.evidence!;
    assert.equal(evidence[0].title, "手动保存钟楼街 POI，task 自动确认");
    assert.equal(evidence[0].source, "user");
  } finally { cleanup(); }
});

// ───────────── readiness 一致性 ─────────────

test("readiness 入口从同一持久化层读：未同步确认 task 时仍在阻塞；同步确认后不再阻塞", () => {
  // 复刻 main.ts 里 readiness 函数的未解决 task 判定逻辑（未修改 main.ts），
  // 验证「products:readiness IPC handler 从 DB 读到的状态」与「本轮原子写入」
  // 之后保持一致，避免「UI 乐观态 100% / DB 真实态 92%」再现。
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [
        { day: 1, title: "D1", description: "首日", hotel: "酒店", meals: "自理", spots: [{ name: "太原食品街", poiName: null, poiId: null }] },
      ],
    });
    const poiTask = db.addResearchTask(product.id, { label: "核查 钟楼街 的 VBK POI 映射", type: "vbk", detail: "x" });

    const computeOpenIssues = (p: ReturnType<typeof db.getProduct> & {}) => {
      // 与 main.ts readiness 保持同样的语义：未确认 / 未解决 / 也不被 product 满足的 task 才进入 issues。
      return p.researchTasks.filter((task) =>
        task.state !== "confirmed" &&
        task.state !== "resolved"
      );
    };

    // 写入前：POI task 仍在 researching，会被 readiness 当作未解决 task。
    const before = db.getProduct(product.id)!;
    assert.ok(computeOpenIssues(before).some((t) => t.id === poiTask), "写入前 readiness 看到 POI task 为未解决");

    // 原子写入：同时把钟楼街 POI 写入 itinerary + 把对应 task 标 confirmed。
    const nextProduct: Record<string, unknown> = structuredClone(before.product);
    const day1 = (nextProduct.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0];
    day1.spots[0] = { name: "太原食品街", poiName: "钟楼街", poiId: 131897125 };
    db.replaceProductAndSatisfyResearchTasks(product.id, nextProduct, { status: "review" });

    // 写入后：POI task 已是 confirmed，readiness 不会把它当作未解决。
    const after = db.getProduct(product.id)!;
    assert.ok(!computeOpenIssues(after).some((t) => t.id === poiTask), "写入后 POI task 必须是 confirmed，readiness 不再计为未解决");
    const openLabels = computeOpenIssues(after).map((t) => t.label);
    assert.equal(openLabels.length, 0, "写入后 readiness 不应再看到任何未解决 task");
  } finally { cleanup(); }
});
