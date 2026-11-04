import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import { applyProductPatch } from "../../src/main/operations/product-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

/**
 * 真实样本：泸州 2 天 1 晚自由行（`cd853daa`）。运营已把查不到 POI 的「东门古城墙」「珠子街」
 * 改为自由活动，Agent 随后为补回漏掉的景点整天重写 spots，把两项写回景点类型，
 * 运营不得不再处理一次。
 */
const NO_POI_EVIDENCE = { id: "e", title: "[itinerary-kind:no-poi] 当前条目明确为自由活动或其他，无需 POI 核查，自动确认", source: "user", retrievedAt: "t", accepted: true };

function draft(withOperatorEvidence: boolean): ProductDetail {
  const product = buildProductSnapshot({ destination: "泸州", days: 2, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 2, nights: 1, meetingCity: "泸州", destinationCity: "泸州", destination: "泸州", province: "四川",
    userIdea: "day1:泸州老窖旅游区-忠山公园-东门古城墙-珠子街-入住泸州\nday2：张坝桂圆林-尧坝古镇-返程",
  });
  Object.assign(product.product.operations!, { pickupCity: "泸州" });
  product.product.itinerary = [
    { day: 1, title: "忠山公园 · 东门古城墙 · 珠子街", description: "游览", hotel: "泸州（待匹配）", meals: "自理", spots: [
      { name: "忠山公园", kind: "attraction", poiName: null, poiId: null },
      { name: "东门古城墙", kind: "free", poiName: null, poiId: null },
      { name: "珠子街", kind: "other", poiName: null, poiId: null },
    ] },
    { day: 2, title: "张坝桂圆林 · 尧坝古镇", description: "游览", hotel: "无", meals: "自理", spots: [
      { name: "张坝桂圆林", kind: "attraction", poiName: null, poiId: null },
      { name: "尧坝古镇", kind: "attraction", poiName: null, poiId: null },
    ] },
  ] as never;
  product.researchTasks = ["东门古城墙", "珠子街"].map((name) => ({
    id: name, label: `核查 ${name} 的 VBK POI 映射`, type: "vbk", status: "succeeded", state: "confirmed",
    detail: null, evidence: withOperatorEvidence ? [NO_POI_EVIDENCE] : [],
  })) as never;
  return product;
}

const agentDay1 = { day: 1, spots: [
  { name: "泸州老窖旅游区", kind: "attraction" },
  { name: "忠山公园", kind: "attraction" },
  { name: "东门古城墙", kind: "attraction" },
  { name: "珠子街" },
] };

test("Agent 整天重写 spots 时保留运营已确认的非景点分类", () => {
  const product = draft(true);
  const next = applyProductPatch(product.product, agentPatchOperations(product, { itinerary: [agentDay1] }));
  const spots = (next.itinerary as any[])[0].spots;
  assert.deepEqual(spots.map((spot: any) => [spot.name, spot.kind]), [
    ["泸州老窖旅游区", "attraction"], ["忠山公园", "attraction"], ["东门古城墙", "free"], ["珠子街", "other"],
  ]);
});

test("没有运营确认凭证时，Agent 给出的类型照常生效", () => {
  const product = draft(false);
  const next = applyProductPatch(product.product, agentPatchOperations(product, { itinerary: [agentDay1] }));
  assert.equal((next.itinerary as any[])[0].spots[2].kind, "attraction");
});
