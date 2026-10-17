import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { DEFAULT_AUTO_RESEARCH_CONFIRMATION } from "../../src/main/infrastructure/database/parts/research-tasks.js";
import {
  refreshSatisfiedResearchTasks,
  shouldSyncConfirmedResearchTasks,
} from "../../src/main/operations/research-refresh.js";
import { isResearchTaskSatisfiedByProduct } from "../../src/shared/research-task-satisfaction.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";

const ambiguousDetail = "已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI";
const taskLabel = "核查 城固张骞故里 的 VBK POI 映射";

function withDb() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-ambiguous-poi-"));
  return new VbkDatabase(dataPath);
}

function addMatchedItinerary(db: VbkDatabase, localProductId: string) {
  const product = db.getProduct(localProductId)!;
  db.updateProduct(localProductId, {
    ...product.product,
    itinerary: [{
      day: 1,
      spots: [{
        name: "城固张骞故里",
        poiName: "张骞纪念馆",
        poiId: 151283243,
        province: "陕西",
        city: "汉中",
        district: "城固",
      }],
    }],
    manualReview: {
      itinerarySpotRemovals: [{ day: 2, name: "运营已删除的景点", removedAt: "2026-10-14T00:00:00.000Z" }],
    },
  });
}

test("要求人工选择的 POI task 不会因同名和正整数 POI ID 自动确认", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 1, productForm: "privateTour" });
  addMatchedItinerary(db, product.id);
  const taskId = db.addResearchTask(product.id, { label: taskLabel, type: "vbk", detail: ambiguousDetail });

  const current = db.getProduct(product.id)!;
  assert.equal(isResearchTaskSatisfiedByProduct(current.researchTasks.find(task => task.id === taskId)!, current.product), false);
  const result = refreshSatisfiedResearchTasks(db, product.id);

  assert.equal(result.confirmed, 0);
  assert.equal(result.reopened, 0);
  assert.equal(db.getProduct(product.id)!.researchTasks.find(task => task.id === taskId)?.state, "researching");
});

test("刷新只重开历史自动确认的歧义 POI task，保留凭证且不触发远端同步", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 1, productForm: "privateTour" });
  addMatchedItinerary(db, product.id);
  const taskId = db.addResearchTask(product.id, { label: taskLabel, type: "vbk", detail: ambiguousDetail });
  db.markResearchTasksSatisfied(product.id, [taskId], DEFAULT_AUTO_RESEARCH_CONFIRMATION);
  const before = db.getProduct(product.id)!;
  const evidenceBefore = before.researchTasks.find(task => task.id === taskId)!.evidence;
  const productJsonBefore = structuredClone(before.product);

  const first = refreshSatisfiedResearchTasks(db, product.id);
  assert.deepEqual(first.confirmedTaskIds, []);
  assert.equal(first.confirmed, 0);
  assert.equal(first.reopened, 1);
  assert.deepEqual(first.reopenedTaskIds, [taskId]);
  assert.equal(shouldSyncConfirmedResearchTasks(first), false);

  const reopened = db.getProduct(product.id)!;
  const reopenedTask = reopened.researchTasks.find(task => task.id === taskId)!;
  assert.equal(reopenedTask.state, "researching");
  assert.equal(reopenedTask.status, "queued");
  assert.deepEqual(reopenedTask.evidence, evidenceBefore);
  assert.deepEqual(reopened.product, productJsonBefore);
  assert.deepEqual(reopened.product.manualReview, productJsonBefore.manualReview);

  const second = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(second.confirmed, 0);
  assert.equal(second.reopened, 0);

  db.markResearchAccepted(product.id, taskId, "运营已人工确认张骞纪念馆");
  const manual = db.getProduct(product.id)!;
  assert.equal(manual.researchTasks.find(task => task.id === taskId)?.state, "confirmed");
  assert.match(manual.researchTasks.find(task => task.id === taskId)?.evidence[0]?.title ?? "", /人工确认/);
  const final = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(final.confirmed, 0);
  assert.equal(final.reopened, 0);
  assert.equal(db.getProduct(product.id)!.researchTasks.find(task => task.id === taskId)?.state, "confirmed");
});

test("重开范围不覆盖普通自动确认、非 VBK task 或人工确认", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 1, productForm: "privateTour" });
  addMatchedItinerary(db, product.id);
  const normalId = db.addResearchTask(product.id, {
    label: "核查 城固张骞故里 的 VBK POI 映射", type: "vbk", detail: "历史 POI 匹配已通过",
  });
  const webId = db.addResearchTask(product.id, {
    label: "核查 城固张骞故里 的 VBK POI 映射", type: "web", detail: ambiguousDetail,
  });
  const manualId = db.addResearchTask(product.id, {
    label: "核查 张骞纪念馆 的 VBK POI 映射", type: "vbk", detail: ambiguousDetail,
  });
  db.markResearchTasksSatisfied(product.id, [normalId, webId], DEFAULT_AUTO_RESEARCH_CONFIRMATION);
  db.markResearchAccepted(product.id, manualId, "运营已人工确认候选");

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.reopened, 0);
  const tasks = new Map(db.getProduct(product.id)!.researchTasks.map(task => [task.id, task]));
  for (const id of [normalId, webId, manualId]) {
    assert.equal(tasks.get(id)?.state, "confirmed");
  }
});

test("受控 POI 解析凭证可结清旧歧义任务，普通或错误映射仍不能结清", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 1, productForm: "privateTour" });
  addMatchedItinerary(db, product.id);
  const taskId = db.addResearchTask(product.id, { label: taskLabel, type: "vbk", detail: ambiguousDetail });

  const wrong = db.confirmVerifiedPoiResearchTasks(product.id, [{
    day: 1, spotName: "城固张骞故里", poiName: "张骞纪念馆", poiId: 999,
    province: "陕西", city: "汉中", district: "城固",
  }]);
  assert.equal(wrong.updated, 0);
  assert.equal(db.getProduct(product.id)!.researchTasks.find(task => task.id === taskId)?.state, "researching");

  const verified = db.confirmVerifiedPoiResearchTasks(product.id, [{
    day: 1, spotName: "城固张骞故里", poiName: "张骞纪念馆", poiId: 151283243,
    province: "陕西", city: "汉中", district: "城固",
  }]);
  assert.deepEqual(verified.taskIds, [taskId]);
  const task = db.getProduct(product.id)!.researchTasks.find(item => item.id === taskId)!;
  assert.equal(task.state, "confirmed");
  assert.equal(task.status, "succeeded");
  assert.equal(task.detail, "当前行程已保存有效的 VBK POI 映射。");
  assert.match(task.evidence.at(-1)?.title ?? "", /\[itinerary-poi:verified\].*151283243/);
  assert.equal(task.evidence.at(-1)?.source, "vbk");
});

test("同日两个锁定别名解析为同一 POI 后生成可审计的去重凭证", () => {
  const db = withDb();
  const created = db.createProduct({
    destination: "拉萨", days: 1, productForm: "privateTour",
    userIdea: "D1天：羊卓雍措 - 看点：羊卓雍湖",
  });
  const current = db.getProduct(created.id)!;
  db.updateProduct(created.id, { ...current.product, itinerary: [{
    day: 1,
    spots: [{ name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, kind: "attraction" }],
  }] });

  const result = db.confirmVerifiedPoiResearchTasks(created.id, [
    { day: 1, spotName: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105 },
    { day: 1, spotName: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105 },
  ]);

  assert.equal(result.updated, 1);
  const product = db.getProduct(created.id)!;
  const aliasTask = product.researchTasks.find((task) => task.label === "核查 羊卓雍湖 的 VBK POI 映射");
  assert.equal(aliasTask?.state, "confirmed");
  assert.match(aliasTask?.evidence[0]?.title ?? "", /\[itinerary-poi:verified\].*羊卓雍湖.*82105/u);
  assert.equal(itineraryInputContractError(product, product.product.itinerary), undefined);
});

test("已持久化的受控 POI 与本轮别名解析一致时也生成去重凭证", () => {
  const db = withDb();
  const created = db.createProduct({
    destination: "拉萨", days: 1, productForm: "privateTour",
    userIdea: "D1天：羊卓雍措 - 看点：羊卓雍湖",
  });
  const current = db.getProduct(created.id)!;
  db.updateProduct(created.id, { ...current.product, itinerary: [{
    day: 1,
    spots: [{ name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, kind: "attraction" }],
  }] });

  const result = db.confirmVerifiedPoiResearchTasks(created.id, [
    { day: 1, spotName: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105 },
  ]);

  assert.equal(result.updated, 1);
  const product = db.getProduct(created.id)!;
  const aliasTask = product.researchTasks.find((task) => task.label === "核查 羊卓雍湖 的 VBK POI 映射");
  assert.equal(aliasTask?.state, "confirmed");
  assert.match(aliasTask?.evidence[0]?.title ?? "", /\[itinerary-poi:verified\].*羊卓雍湖.*82105/u);
  assert.equal(itineraryInputContractError(product, product.product.itinerary), undefined);
});
