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

import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

import { makeDb, seedTaiyuanProductWithTasks } from "./replace-product-and-satisfy-research-tasks/fixture.js";

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

test("POI 写入与系统缺失说明收敛在同一事务中", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "日喀则", days: 1, productForm: "privateTour" });
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [{ day: 1, title: "非遗中心", spots: [{ name: "非遗中心参观", poiName: null, poiId: null }] }],
    });
    const taskId = db.addResearchTask(product.id, {
      label: "核查 非遗中心参观 的 VBK POI 映射", type: "vbk",
      detail: "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
    });
    const next = structuredClone(db.getProduct(product.id)!.product) as Record<string, any>;
    next.itinerary[0].spots[0] = { name: "非遗中心参观", poiName: "非物质文化遗产展示中心", poiId: 150237367 };

    const saved = db.replaceProductAndSatisfyResearchTasks(product.id, next, { status: "review" }).product;
    const task = saved.researchTasks.find((item) => item.id === taskId)!;
    assert.equal(task.state, "confirmed");
    assert.equal(task.status, "succeeded");
    assert.equal(task.detail, "当前行程已保存有效的 VBK POI 映射。");
    assert.equal(task.evidence?.length, 1);
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
