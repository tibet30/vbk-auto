import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { applyItinerarySpotRemove } from "../../src/main/operations/manual-review-itinerary-field.js";
import { refreshSatisfiedResearchTasks } from "../../src/main/operations/research-refresh.js";
import { isResearchTaskSatisfiedByProduct } from "../../src/shared/research-task-satisfaction.js";

const failure = "已找到候选 POI，但其地域与产品主城市不一致；请确认当天行程地点范围或手动绑定 POI";
const task = (name: string) => ({ label: `核查 ${name} 的 VBK POI 映射`, type: "vbk" as const, detail: failure });

test("潮汕人工删除四项后原子结清地域任务，重读和继续准备均不再阻塞", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-removal-reconcile-"));
  const db = new VbkDatabase(dir);
  const product = db.createProduct({ destination: "潮汕", days: 5, productForm: "privateTour" });
  const names = ["彩虹公路", "2号公路", "南生百货", "镇邦美食街"];
  db.updateProduct(product.id, { ...product.product, itinerary: [
    { day: 2, spots: names.slice(0, 2).map(name => ({ name })) },
    { day: 3, spots: names.slice(2).map(name => ({ name })) },
  ] });
  for (const name of names) db.addResearchTask(product.id, task(name));
  const unrelated = db.addResearchTask(product.id, task("另一个未完成景点"));
  for (const dayIndex of [0, 0, 1, 1]) {
    const current = db.getProduct(product.id)!;
    const next = applyItinerarySpotRemove(current.product, { field: "itinerarySpotRemove", dayIndex, spotIndex: 0 });
    const result = db.replaceProductAndSatisfyResearchTasks(product.id, next);
    assert.equal(result.confirmedTaskIds.length, 1);
  }
  const reloaded = new VbkDatabase(dir).getProduct(product.id)!;
  for (const name of names) {
    const row = reloaded.researchTasks.find(row => row.label === task(name).label)!;
    assert.equal(row.status, "succeeded");
    assert.equal(row.state, "confirmed");
    assert.match(row.evidence[0]!.title, /运营已手动删除/);
    assert.doesNotMatch(row.evidence[0]!.title, /已保存有效.*POI/);
  }
  assert.equal(reloaded.researchTasks.find(row => row.id === unrelated)!.state, "researching");
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 0);

  // Re-adding the slot revokes the deletion outcome and reopens only its task.
  const restored = structuredClone(reloaded.product);
  (restored.itinerary as Array<{ spots: unknown[] }>)[0]!.spots.push({ name: names[0] });
  const result = db.replaceProductAndSatisfyResearchTasks(product.id, restored);
  assert.equal(result.product.researchTasks.find(row => row.label === task(names[0]!).label)!.state, "researching");
});

test("无人工凭证的消失、另一天同名未核验、组合任务中的未完成备选不能结案", () => {
  const receipt = { manualReview: { itinerarySpotRemovals: [{ day: 2, name: "甲", removedAt: "2026-10-10T00:00:00Z" }] } };
  assert.equal(isResearchTaskSatisfiedByProduct(task("甲"), { itinerary: [] }), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task("甲"), { ...receipt, itinerary: [{ day: 3, spots: [{ name: "甲" }] }] }), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task("甲 或 乙"), { ...receipt, itinerary: [{ day: 2, spots: [{ name: "乙" }] }] }), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task("甲 或 乙"), { ...receipt, itinerary: [{ day: 2, spots: [{ name: "乙", poiName: "乙", poiId: 12 }] }] }), true);
});

test("删除凭证按 POI 名等价键结清括号注释 / 动作词写法不同的核查任务", () => {
  const product = { manualReview: { itinerarySpotRemovals: [{ day: 2, name: "广济桥", removedAt: "2026-10-14T00:00:00.000Z" }] }, itinerary: [] };
  assert.equal(isResearchTaskSatisfiedByProduct(task("广济桥"), product), true);
  assert.equal(isResearchTaskSatisfiedByProduct(task("广济桥（不上桥）"), product), true);
  assert.equal(isResearchTaskSatisfiedByProduct(task("非遗中心参观"), {
    manualReview: { itinerarySpotRemovals: [{ day: 3, name: "非遗中心", removedAt: "2026-10-14T00:00:00.000Z" }] }, itinerary: [],
  }), true);
  // 同城不同景点不能被名称包含关系误结案。
  assert.equal(isResearchTaskSatisfiedByProduct(task("汉中市古汉台博物馆"), {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "汉中", removedAt: "2026-10-14T00:00:00.000Z" }] }, itinerary: [],
  }), false);
});

test("删除凭证不能结清另一天仍未匹配的同名景点", () => {
  const product = {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "广济桥", removedAt: "2026-10-14T00:00:00.000Z" }] },
    itinerary: [
      { day: 1, spots: [] },
      { day: 2, spots: [{ name: "广济桥", poiName: null, poiId: null, kind: "attraction" }] },
    ],
  };
  assert.equal(isResearchTaskSatisfiedByProduct(task("广济桥（不上桥）"), product), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task("广济桥"), product), false);
  // 另一天的同名景点补齐 POI 后，任务才允许结案。
  (product.itinerary[1]!.spots[0] as { poiName: string | null; poiId: number | null }).poiName = "广济桥";
  (product.itinerary[1]!.spots[0] as { poiName: string | null; poiId: number | null }).poiId = 85862;
  assert.equal(isResearchTaskSatisfiedByProduct(task("广济桥（不上桥）"), product), true);
});

test("suggestPoi 未匹配兜底分支同样按 POI 名等价键判断是否有同类景点", () => {
  const obsolete = "suggestPoi 未匹配；已保留原景点和原行程位置，仅以文字录入";
  const listed = (name: string) => ({ label: `核查 ${name} 的 VBK POI 映射`, type: "vbk" as const, detail: obsolete });
  const product = {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "广济桥", removedAt: "2026-10-14T00:00:00.000Z" }] },
    itinerary: [
      { day: 1, spots: [] },
      { day: 2, spots: [{ name: "广济桥", kind: "attraction", poiName: null, poiId: null }] },
    ],
  };
  assert.equal(isResearchTaskSatisfiedByProduct(listed("广济桥（不上桥）"), product), false);
  (product.itinerary[1]!.spots as unknown[]).length = 0;
  assert.equal(isResearchTaskSatisfiedByProduct(listed("广济桥（不上桥）"), product), true);
});
