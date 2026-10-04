import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { preparationItineraryRecovery } from "../../src/main/agent/preparation-itinerary-recovery.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";

function product() {
  const p = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  Object.assign(p.product.basicInfo!, { province: "西藏", subtitle: "三日游", operationNotes: "按原行程", nights: 2,
    userIdea: "第一天：帕拉庄园 → 住日喀则。\n第二天：羊卓雍湖 → 住日喀则。\n第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺参观 → 送火车。" });
  Object.assign(p.product.operations!, { pickupCity: "日喀则" });
  p.product.itinerary = [
    { day: 1, title: "游览", description: "按原顺序", meals: "自理", hotel: "酒店", spots: [{ name: "帕拉庄园", poiName: "帕拉庄园", poiId: 85093 }] },
    { day: 2, title: "游览", description: "按原顺序", meals: "自理", hotel: "酒店", spots: [{ name: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105 }] },
    { day: 3, title: "送站", description: "按原顺序送站", meals: "自理", hotel: "酒店", hotelDescription: "送站日不实际安排住宿", spots: [
      { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 79437758, relation: "or", timeOfDay: "morning" },
      { name: "非遗中心参观", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
      { name: "扎什伦布寺参观", poiName: "扎什伦布寺", poiId: 76348, relation: "and", timeOfDay: "afternoon" },
    ] },
  ] as never;
  p.researchTasks = [
    { id: "removed", label: "核查 非遗中心参观 的 VBK POI 映射", type: "vbk", state: "pending" },
    { id: "combined", label: "核查 非遗中心参观 或 日喀则博物馆 的 VBK POI 映射", type: "vbk", state: "pending" },
    { id: "other", label: "核查 其他景点 的 VBK POI 映射", type: "vbk", state: "pending" },
  ] as never;
  return p;
}

test("恢复入口不再自动删除已命名二选一景点，保留原槽位等待真实 POI 处理", () => {
  const p = product();
  const before = structuredClone(p);
  const recovery = preparationItineraryRecovery(p)!;
  assert.ok(recovery);
  assert.deepEqual(recovery.taskIds, []);
  assert.equal(recovery.product.itinerary[2].hotel, "无");
  assert.deepEqual((recovery.product.itinerary[2].spots as Array<{ name: string }>).map(x => x.name), ["日喀则博物馆", "非遗中心参观", "扎什伦布寺参观"]);
  assert.deepEqual(p, before);
  const after = { ...p, product: recovery.product, researchTasks: p.researchTasks };
  const evaluation = evaluatePreparationCompletion(after);
  assert.equal(evaluation.currentNode, "poiResolution");
  assert.ok(!evaluation.missing.includes("酒店候选：第 3 天"));
  assert.equal(preparationItineraryRecovery(after), undefined);
});

test("已创建携程产品不改动已批准方案，全部不可用时不移除原选项", () => {
  const p = product(); p.productId = "123";
  assert.equal(preparationItineraryRecovery(p), undefined);
  delete p.productId;
  const itinerary = p.product.itinerary as Array<{ spots: Array<Record<string, unknown>> }>;
  itinerary[2].spots[0].poiId = null; itinerary[2].spots[0].poiName = null;
  const recovery = preparationItineraryRecovery(p)!;
  assert.equal((recovery.product.itinerary[2].spots as unknown[]).length, 3);
  assert.deepEqual(recovery.taskIds, []);
});

test("历史行程缺少 OR 首项且无人工凭证时，准备状态不能假装 ready", () => {
  const p = product();
  (p.product.itinerary![2]!.spots as Array<Record<string, unknown>>).shift();
  const evaluation = evaluatePreparationCompletion(p);
  assert.equal(evaluation.ready, false);
  assert.ok(evaluation.blockingReasons.some((reason) => /二选一景点必须全部保留.*日喀则博物馆/.test(reason)));
});
