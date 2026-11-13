/**
 * 回归：运营在行程里显式选定 POI 后，同名「请手动选择 POI」决策门 task 必须结清。
 *
 * 真实案例（产品 e14df45d-a2df-461d-996d-218c2f56fb0a「西安6天5晚私家团」）：
 *   - day4 spot「张骞故里」已由运营手动选定 张骞纪念馆 / poiId=151283243；
 *   - research_tasks「核查 张骞故里 的 VBK POI 映射」detail=
 *     「已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI」
 *     仍是 queued / researching，运营因此认为「POI 明明选过了却还在待核查里」。
 *
 * 根因：`isResearchTaskSatisfiedByProduct` 出于防误确认，刻意不把「同名 +
 * 正整数 POI ID」当作歧义决策门的结清依据；显式人工决策凭证原先只在自动 POI
 * 解析路径被调用。现在凭证与结清都收在 `ProductCommandService.manualField`
 * 同一事务内，本测试按生产顺序验证单次保存即结清，并覆盖护栏与自动谓词。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { verifiedMappingForManualPoi } from "../../src/main/operations/manual-review-poi-selection.js";
import { routeLocationBlockers } from "../../src/shared/route-location-evidence.js";
import { poiBindingWasAdjudicated } from "../../src/shared/poi-adjudication-receipt.js";
import { isResearchTaskSatisfiedByProduct } from "../../src/shared/research-task-satisfaction.js";

const AMBIGUOUS_DETAIL = "已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI";
const SAVED_POI_DETAIL = "当前行程已保存有效的 VBK POI 映射。";
const SPOT_NAME = "张骞故里";
const POI_NAME = "张骞纪念馆";
const POI_ID = 151283243;

type PoiInput = Parameters<typeof verifiedMappingForManualPoi>[1];

function withDb() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-manual-poi-task-"));
  return {
    db: new VbkDatabase(dataPath),
    cleanup: () => { try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

function seedProduct(db: VbkDatabase, taskDetail = AMBIGUOUS_DETAIL) {
  const product = db.createProduct({ destination: "西安", days: 6, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [
      { day: 4, title: "汉中城固", spots: [{ name: SPOT_NAME, poiName: null, poiId: null, kind: "attraction" }] },
    ],
  });
  const taskId = db.addResearchTask(product.id, {
    label: `核查 ${SPOT_NAME} 的 VBK POI 映射`, type: "vbk", detail: taskDetail,
  });
  return { product, taskId };
}

function manualPoiInput(poiName = POI_NAME, poiId = POI_ID): PoiInput {
  return { field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0, poiName, poiId };
}

/** 生产路径：`products:updateReviewField` 一次命令完成落库、凭证与结清。 */
function saveManualField(db: VbkDatabase, localProductId: string, input: PoiInput) {
  const before = db.getProduct(localProductId)!;
  return new ProductMutationService(db).commands.manualField(
    { localProductId, source: "user", expectedVersion: before.productJsonVersion ?? 0 }, input);
}

test("人工选定 POI 单次保存即结清决策门，并留下受控凭证", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db);
    const result = saveManualField(db, product.id, manualPoiInput());

    // 不再有「绑定已写、任务未结」的中间态：凭证与结清同一次事务。
    const task = result.researchTasks.find(item => item.id === taskId)!;
    assert.equal(task.state, "confirmed");
    assert.equal(task.status, "succeeded");
    assert.equal(task.detail, SAVED_POI_DETAIL);
    assert.match(task.evidence.at(-1)?.title ?? "", /\[itinerary-poi:verified\].*151283243/);
    assert.equal(task.evidence.at(-1)?.source, "vbk");

    const spot = (result.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!.spots[0]!;
    assert.equal(spot.poiName, POI_NAME);
    assert.equal(spot.poiId, POI_ID);
    assert.equal(poiBindingWasAdjudicated(result.product, 4, SPOT_NAME, POI_ID), true);
  } finally {
    cleanup();
  }
});

test("人工重新选定已保留的 POI 后结清本轮核验任务", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db,
      "本轮 POI 核验未完成：当前查询召回多个候选，无法安全确定唯一地点，已保留先前绑定；请重新查询或手动选择 POI");
    const result = saveManualField(db, product.id, manualPoiInput());
    assert.equal(result.researchTasks.find(item => item.id === taskId)?.state, "confirmed");
  } finally {
    cleanup();
  }
});

test("人工选定受控候选后，同一次保存留下当前路线的地域核验凭证", () => {
  const { db, cleanup } = withDb();
  try {
    const sourceRoute = "：【那曲市-比如县】骷髅墙-怒江第一湾-帕拉晶塔-羊秀乡-住比如（不含餐）";
    const detail = db.createProduct({ destination: "拉萨", days: 1, productForm: "privateTour",
      userIdea: `D1${sourceRoute}` });
    db.updateProduct(detail.id, {
      ...detail.product,
      basicInfo: { ...detail.product.basicInfo, province: "西藏", userIdea: `D1${sourceRoute}` },
      itinerary: [{ day: 1, title: "那曲至比如", spots: [
        { name: "骷髅墙", poiName: null, poiId: null, kind: "attraction" },
      ] }],
      diagnostics: { routeLocations: [{ day: 1, name: "比如", districtId: 120390,
        province: "西藏", city: "那曲", district: "比如", position: sourceRoute.lastIndexOf("比如"),
        sourceRoute, routeKey: JSON.stringify([sourceRoute, 1]) }] },
    });
    const input: PoiInput = { ...manualPoiInput("达木寺骷髅墙", 82136),
      province: "西藏", city: "那曲", district: "比如" };

    const result = saveManualField(db, detail.id, input);
    assert.deepEqual(routeLocationBlockers(result.product), [],
      "运营已从当前受控候选中选定，保存后不应仍要求重复处理地域");
  } finally {
    cleanup();
  }
});

test("AI patch 直接写 poiId 而无受控凭证时，绑定在落库前被剥离", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db);
    const current = db.getProduct(product.id)!;
    const itinerary = structuredClone(current.product.itinerary) as Array<{ spots: Array<Record<string, unknown>> }>;
    itinerary[0]!.spots[0] = { name: SPOT_NAME, poiName: POI_NAME, poiId: POI_ID, kind: "attraction" };
    const result = new ProductMutationService(db).applyAiPatch(product.id, [
      { op: "replace", path: "/itinerary", value: itinerary },
    ]);
    assert.equal(result.applied, true);

    const spot = (result.product.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!.spots[0]!;
    assert.equal(spot.poiId ?? null, null, "无凭证的 AI 绑定必须被剥离，逼 Agent 走受控选择器");
    assert.equal(spot.poiName ?? null, null);
    assert.equal(result.product.researchTasks.find(item => item.id === taskId)?.state, "researching");
  } finally {
    cleanup();
  }
});

test("规划模块整包写入（ai 来源）只告警不剥离，避免误伤阶段产物", () => {
  const { db, cleanup } = withDb();
  try {
    const { product } = seedProduct(db);
    const current = db.getProduct(product.id)!;
    const itinerary = structuredClone(current.product.itinerary) as Array<{ spots: Array<Record<string, unknown>> }>;
    itinerary[0]!.spots[0] = { name: SPOT_NAME, poiName: POI_NAME, poiId: POI_ID, kind: "attraction" };
    const saved = new ProductMutationService(db).commands.mergeChanges(
      product.id, current, { ...current.product, itinerary }, "ai");

    const spot = (saved.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!.spots[0]!;
    assert.equal(spot.poiId, POI_ID, "只有 AI patch 入口剥离；阶段整包写入保留并留日志");
  } finally {
    cleanup();
  }
});

test("已存在的旧绑定不受护栏影响，资源回填不会清掉历史 POI", () => {
  const { db, cleanup } = withDb();
  try {
    const { product } = seedProduct(db);
    const current = db.getProduct(product.id)!;
    const itinerary = structuredClone(current.product.itinerary) as Array<{ spots: Array<Record<string, unknown>> }>;
    itinerary[0]!.spots[0] = { name: SPOT_NAME, poiName: POI_NAME, poiId: POI_ID, kind: "attraction" };
    db.updateProduct(product.id, { ...current.product, itinerary });

    const before = db.getProduct(product.id)!;
    const saved = new ProductMutationService(db).commands.mergeChanges(
      product.id, before, { ...before.product, operations: { ...(before.product.operations ?? {}), remark: "资源回填" } }, "resource");
    const spot = (saved.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!.spots[0]!;
    assert.equal(spot.poiId, POI_ID, "未变更绑定不该被护栏剥离");
  } finally {
    cleanup();
  }
});

test("整包 JSON 编辑新增无凭证 POI 时明确拒绝，不静默落库", () => {
  const { db, cleanup } = withDb();
  try {
    const { product } = seedProduct(db);
    const current = db.getProduct(product.id)!;
    const next = structuredClone(current.product) as { itinerary: Array<{ spots: Array<Record<string, unknown>> }> };
    next.itinerary[0]!.spots[0] = { name: SPOT_NAME, poiName: POI_NAME, poiId: POI_ID, kind: "attraction" };
    const service = new ProductMutationService(db);

    assert.throws(() => service.commands.replaceFull(
      { localProductId: product.id, source: "user", expectedVersion: current.productJsonVersion ?? 0 },
      next as Record<string, unknown>,
      { status: current.status, preserveVerifiedItineraryPois: false, allowItineraryRemovalRestore: true,
        allowMeetingCityCorrection: true, rejectUnreceiptedPoi: true },
    ), /景点选择器/u);
    const saved = (db.getProduct(product.id)!.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!.spots[0]!;
    assert.equal(saved.poiId ?? null, null, "被拒绝的写入不能落库");
  } finally {
    cleanup();
  }
});

test("决策门 gate 从库里读回后仍拒绝自动结清（新旧文案都不漂移）", () => {
  const { db, cleanup } = withDb();
  try {
    const product = db.createProduct({ destination: "西安", days: 6, productForm: "privateTour" });
    // 模拟历史/手写绑定：spot 已有 poiId，但没有受控凭证。
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [{ day: 4, title: "汉中城固", spots: [{ name: SPOT_NAME, poiName: POI_NAME, poiId: POI_ID, kind: "attraction" }] }],
    });
    const taskId = db.addResearchTask(product.id, {
      label: `核查 ${SPOT_NAME} 的 VBK POI 映射`, type: "vbk",
      detail: "当前查询无法唯一确定地点；请运营确认", gate: "manual_poi_selection",
    });
    const current = db.getProduct(product.id)!;
    const settled = db.markResearchTasksSatisfiedByProduct(product.id, current.product);
    assert.deepEqual(settled.taskIds, [], "gate 任务不能被同名绑定自动结清");
    assert.equal(db.getProduct(product.id)!.researchTasks.find(item => item.id === taskId)?.state, "researching");
  } finally {
    cleanup();
  }
});

test("人工 POI 写入即使没有新结清任务也同步远端产品快照", () => {
  const source = fs.readFileSync(path.resolve("src/main/ipc/product-ai-ipc.ts"), "utf8");
  const handler = source.match(/ipcMain\.handle\("products:updateReviewField"[\s\S]*?return resultProduct;\n  \}\);/)?.[0] ?? "";
  assert.match(handler, /resultProduct = await syncConfirmedResearchTasksToRemote\(/);
  assert.doesNotMatch(handler, /if \(confirmedTaskIds\.length > 0\) \{[\s\S]*?syncConfirmedResearchTasksToRemote/);
  // 本地已提交后远端同步失败不能让保存报错，也不能跳过广播。
  assert.match(handler, /catch \(error\) \{[\s\S]*?remote sync failed after local commit[\s\S]*?broadcastProduct\(resultProduct\)/);
});

test("带 gate 的新文案决策门同样由凭证结清（不再依赖正则措辞）", () => {
  const { db, cleanup } = withDb();
  try {
    const product = db.createProduct({ destination: "西安", days: 6, productForm: "privateTour" });
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [{ day: 4, title: "汉中城固", spots: [{ name: SPOT_NAME, poiName: null, poiId: null, kind: "attraction" }] }],
    });
    // 措辞刻意避开旧正则的「多个候选 / 确定唯一」分支，只靠 gate 表达决策门。
    const taskId = db.addResearchTask(product.id, {
      label: `核查 ${SPOT_NAME} 的 VBK POI 映射`,
      type: "vbk",
      detail: "当前查询无法唯一确定地点；请运营确认",
      gate: "manual_poi_selection",
    });

    const before = db.getProduct(product.id)!;
    assert.equal(isResearchTaskSatisfiedByProduct(
      before.researchTasks.find(item => item.id === taskId)!, before.product), false,
      "决策门不得被自动谓词放过");

    const result = saveManualField(db, product.id, manualPoiInput());
    assert.equal(result.researchTasks.find(item => item.id === taskId)?.state, "confirmed");
  } finally {
    cleanup();
  }
});

test("无歧义的同名 POI task 仍由自动确认谓词结清", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db, "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI");
    const result = saveManualField(db, product.id, manualPoiInput());
    assert.equal(result.researchTasks.find(item => item.id === taskId)?.state, "confirmed");
  } finally {
    cleanup();
  }
});
