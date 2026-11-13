import assert from "node:assert/strict";
import test from "node:test";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";
import { preserveOperatorActivityKinds } from "../../src/shared/preserve-operator-itinerary-kinds.js";
import {
  operatorItinerarySpotKinds,
  reconcileOperatorItineraryKindsFromProduct,
} from "../../src/shared/operator-itinerary-kinds.js";

const SPOT_ID = "sp_0123456789ab";

/** 第 4 天两个查不到可绑定 POI 的条目：正是「手动改成其他后又被改回景点」的场景。 */
function currentProduct(spots?: Array<Record<string, unknown>>) {
  return {
    itinerary: [{
      day: 4,
      title: "巴尔斯雪山 · 七彩丹霞",
      spots: spots ?? [
        { spotId: SPOT_ID, name: "巴尔斯雪山", kind: "other", poiName: null, poiId: null },
        { name: "七彩丹霞", kind: "other", poiName: null, poiId: null },
      ],
    }],
  } as Record<string, unknown>;
}

function incomingProduct() {
  return {
    itinerary: [{
      day: 4,
      title: "巴尔斯雪山 · 七彩丹霞",
      spots: [
        { spotId: SPOT_ID, name: "巴尔斯雪山", kind: "attraction", poiName: null, poiId: null },
        { name: "七彩丹霞", kind: "attraction", poiName: null, poiId: null },
      ],
    }],
  } as Record<string, unknown>;
}

const spotsOf = (value: Record<string, unknown>) =>
  ((value.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!).spots;

test("人工改成其他会写独立凭证，改回景点用新凭证覆盖", () => {
  const changed = applyManualReviewField(currentProduct(), {
    field: "itinerarySpotKind", dayIndex: 0, spotIndex: 0, kind: "other", spotId: SPOT_ID,
  });
  const records = operatorItinerarySpotKinds(changed);
  assert.deepEqual(records.map((entry) => [entry.day, entry.name, entry.kind]), [[4, "巴尔斯雪山", "other"]]);

  const restored = applyManualReviewField(changed, {
    field: "itinerarySpotKind", dayIndex: 0, spotIndex: 0, kind: "attraction", spotId: SPOT_ID,
  });
  assert.deepEqual(operatorItinerarySpotKinds(restored).map((entry) => entry.kind), ["attraction"]);
});

test("生成把条目改回景点时按人工凭证还原其他，不重建 POI 门禁", () => {
  const current = currentProduct();
  current.manualReview = { itinerarySpotKinds: [{ day: 4, name: "巴尔斯雪山", kind: "other", setAt: "2026-11-13T07:15:30.000Z" }] };
  const next = preserveOperatorActivityKinds(current, incomingProduct());
  const spots = spotsOf(next);
  assert.equal(spots[0]!.kind, "other");
  assert.equal(spots[0]!.poiName, null);
  assert.equal(spots[0]!.poiId, null);
  // 没有凭证的兄弟条目不跟着改：只还原运营真正设置过的条目。
  assert.equal(spots[1]!.kind, "attraction");
});

test("历史数据缺少类型凭证时按核查任务的 no-poi 证据还原", () => {
  const tasks = [{
    type: "vbk",
    label: "核查 巴尔斯雪山 的 VBK POI 映射",
    state: "queued",
    evidence: [{ accepted: true, title: "[itinerary-kind:no-poi] 当前条目明确为自由活动或其他，无需 POI 核查" }],
  }];
  const next = preserveOperatorActivityKinds(currentProduct([
    { name: "巴尔斯雪山", kind: "attraction", poiName: null, poiId: null },
  ]), incomingProduct(), tasks);
  assert.equal(spotsOf(next)[0]!.kind, "other");
});

test("新值已带完整 POI 时不按历史分类把它清掉", () => {
  const tasks = [{
    type: "vbk",
    label: "核查 巴尔斯雪山 的 VBK POI 映射",
    evidence: [{ accepted: true, title: "[itinerary-kind:no-poi] 无需核查" }],
  }];
  const incoming = incomingProduct();
  spotsOf(incoming)[0]!.poiId = 79459703;
  spotsOf(incoming)[0]!.poiName = "巴尔斯雪山";
  const next = preserveOperatorActivityKinds(currentProduct([{ name: "巴尔斯雪山", kind: "attraction" }]), incoming, tasks);
  assert.equal(spotsOf(next)[0]!.kind, "attraction");
  assert.equal(spotsOf(next)[0]!.poiId, 79459703);
});

test("原始 JSON 把类型改回景点后凭证跟随，后续生成不再还原成其他", () => {
  const product = currentProduct([{ spotId: SPOT_ID, name: "巴尔斯雪山", kind: "attraction", poiName: null, poiId: null }]);
  product.manualReview = { itinerarySpotKinds: [{ day: 4, name: "巴尔斯雪山", kind: "other", setAt: "2026-11-13T07:15:30.000Z" }] };
  assert.equal(reconcileOperatorItineraryKindsFromProduct(product), true);
  assert.equal(operatorItinerarySpotKinds(product)[0]!.kind, "attraction");
  const next = preserveOperatorActivityKinds(product, incomingProduct());
  assert.equal(spotsOf(next)[0]!.kind, "attraction");
});
