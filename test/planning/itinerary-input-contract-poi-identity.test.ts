import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";

function productWithVerifiedAlias() {
  const product = buildProductSnapshot({ destination: "拉萨", days: 1, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    days: 1,
    meetingCity: "拉萨",
    destinationCity: "拉萨",
    userIdea: "D1天：拉萨—羊卓雍措—普莫雍措—日喀则（宿日喀则） - 看点：羊卓雍湖，普莫雍措",
  });
  product.researchTasks.push({
    id: "yanghu-alias",
    label: "核查 羊卓雍措 的 VBK POI 映射",
    type: "vbk",
    status: "succeeded",
    state: "confirmed",
    evidence: [{
      id: "verified",
      title: "[itinerary-poi:verified] 第1天 羊卓雍措 -> 羊卓雍错 (82105)",
      source: "vbk",
      retrievedAt: "2026-10-16T00:00:00.000Z",
      accepted: true,
    }],
  });
  return product;
}

function itinerary(poiId: number) {
  return [{
    day: 1,
    spots: [
      { name: "羊卓雍湖", poiName: "羊卓雍错", poiId, kind: "attraction" },
      { name: "普莫雍措", poiName: "普姆雍措", poiId: 149349342, kind: "attraction" },
      { name: "日喀则", poiName: "日喀则", poiId: 1, kind: "attraction" },
    ],
  }];
}

test("历史同POI回执不能代替缺失的原路线槽位", () => {
  assert.match(itineraryInputContractError(productWithVerifiedAlias(), itinerary(82105)) ?? "", /缺失：羊卓雍措/);
});

test("名称相似但 POI 身份不一致时不能借用已确认别名绕过完整行程门禁", () => {
  assert.match(itineraryInputContractError(productWithVerifiedAlias(), itinerary(99999)) ?? "", /缺失：羊卓雍措/);
});

test("未接受的映射证据不能作为 POI 别名身份凭证", () => {
  const product = productWithVerifiedAlias();
  product.researchTasks[0]!.evidence![0]!.accepted = false;
  assert.match(itineraryInputContractError(product, itinerary(82105)) ?? "", /缺失：羊卓雍措/);
});

test("两个原名独立保留后可使用相同POI，不依赖历史去重回执", () => {
  const rows = itinerary(82105);
  rows[0]!.spots.unshift({ name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, kind: "attraction" });
  assert.equal(itineraryInputContractError(productWithVerifiedAlias(), rows), undefined);
});
