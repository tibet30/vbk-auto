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
 * 正整数 POI ID」当作歧义决策门的结清依据；而 `confirmVerifiedPoiResearchTasks`
 * 这条显式人工决策凭证只在自动 POI 解析路径（runtime.writeResolvedItineraryPois）
 * 被调用，`products:updateReviewField` 的人工保存路径没有接线。
 *
 * 本测试按生产顺序复现该路径：manualField 命令落库 → 落库后取证
 * （verifiedMappingForManualPoi）→ confirmVerifiedPoiResearchTasks 结清；
 * 并覆盖反例：并发写入不得被借用结清人工决策、无歧义 task 仍由自动谓词结清。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { verifiedMappingForManualPoi } from "../../src/main/operations/manual-review-poi-selection.js";

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

/** 生产路径的第一步：`products:updateReviewField` 命令落库。 */
function saveManualField(db: VbkDatabase, localProductId: string, input: PoiInput) {
  const before = db.getProduct(localProductId)!;
  return new ProductMutationService(db).commands.manualField(
    { localProductId, source: "user", expectedVersion: before.productJsonVersion ?? 0 }, input);
}

/** 生产路径的第二步：落库后取证并结清人工决策门。 */
function settleFromSaved(db: VbkDatabase, localProductId: string, input: PoiInput) {
  const saved = db.getProduct(localProductId)!;
  const mapping = verifiedMappingForManualPoi(saved.product, input);
  const settledTaskIds = mapping ? db.confirmVerifiedPoiResearchTasks(localProductId, [mapping]).taskIds : [];
  return { mapping, settledTaskIds, result: db.getProduct(localProductId)! };
}

test("人工选定 POI 后歧义决策门 task 结清，并留下受控凭证", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db);
    const input = manualPoiInput();
    saveManualField(db, product.id, input);

    // 仅仅落库还不够：决策门 task 由防误确认谓词守住，必须靠显式凭证结清。
    assert.equal(db.getProduct(product.id)!.researchTasks.find(item => item.id === taskId)?.state, "researching");

    const { settledTaskIds, result } = settleFromSaved(db, product.id, input);
    assert.deepEqual(settledTaskIds, [taskId]);
    const task = result.researchTasks.find(item => item.id === taskId)!;
    assert.equal(task.state, "confirmed");
    assert.equal(task.status, "succeeded");
    assert.equal(task.detail, SAVED_POI_DETAIL);
    assert.match(task.evidence.at(-1)?.title ?? "", /\[itinerary-poi:verified\].*151283243/);
    assert.equal(task.evidence.at(-1)?.source, "vbk");
    const spot = (result.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!.spots[0]!;
    assert.equal(spot.poiName, POI_NAME);
    assert.equal(spot.poiId, POI_ID);
  } finally {
    cleanup();
  }
});

test("并发写入改掉同一 spot 后不得借用别人的绑定结清人工决策", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db);
    const input = manualPoiInput();
    saveManualField(db, product.id, input);
    // 核验与结清之间，另一路写入（AI patch / 资源回填）替换了同一 spot 的绑定。
    const current = db.getProduct(product.id)!;
    const itinerary = structuredClone(current.product.itinerary) as Array<{ spots: Array<Record<string, unknown>> }>;
    itinerary[0]!.spots[0] = { name: SPOT_NAME, poiName: "张骞公园-张骞纪念馆", poiId: 38513254, kind: "attraction" };
    db.updateProduct(product.id, { ...current.product, itinerary });

    const { mapping, settledTaskIds } = settleFromSaved(db, product.id, input);
    assert.equal(mapping, null);
    assert.deepEqual(settledTaskIds, []);
    assert.equal(db.getProduct(product.id)!.researchTasks.find(item => item.id === taskId)?.state, "researching");
  } finally {
    cleanup();
  }
});

test("无歧义的同名 POI task 仍由自动确认谓词结清", () => {
  const { db, cleanup } = withDb();
  try {
    const { product, taskId } = seedProduct(db, "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI");
    const input = manualPoiInput();
    saveManualField(db, product.id, input);
    assert.equal(db.getProduct(product.id)!.researchTasks.find(item => item.id === taskId)?.state, "confirmed");
  } finally {
    cleanup();
  }
});
