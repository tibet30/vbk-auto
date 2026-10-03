import test from "node:test";
import assert from "node:assert/strict";
import { isPlanningPoiCandidateInContext, resolvePlanningPoiAutoSelection } from "../../src/main/planning/poi-auto-selection.js";

const candidate = (poiName: string, city: string, province: string, poiId = 1) => ({
  index: 1, poiName, city, province, poiId, selectable: true, textFields: [],
});

test("潮汕原行程明确的潮州日能绑定四个潮州景点，保留州字和城市锚点", () => {
  const names = ["潮州古城", "广济桥", "牌坊街", "开元寺"];
  const product = { basicInfo: { meetingCity: "潮汕", destinationCity: "潮汕", province: "广东" },
    itinerary: [{ title: "潮州古城游览", spots: names.map(name => ({ name })) }] };
  for (const name of names) {
    assert.equal(isPlanningPoiCandidateInContext(candidate(name, "潮州市", "广东省"),
      product.basicInfo, product, name), true);
    assert.equal(isPlanningPoiCandidateInContext(candidate(name, "泉州", "福建"),
      product.basicInfo, product, name), false);
  }
  assert.equal(product.basicInfo.destinationCity, "潮汕");
});

test("日喀则原行程的羊卓雍湖接受山南官方羊卓雍错并继续营业核验", async () => {
  const product = { itinerary: [{ spots: [{ name: "羊卓雍湖" }] }] };
  const context = { destinationCity: "日喀则", province: "西藏自治区" };
  let checked = 0;
  const result = await resolvePlanningPoiAutoSelection({
    localProductId: "replay", keyword: "羊卓雍湖", product, context,
    detail: { httpStatus: 200, businessStatus: "Success", poiListCount: 1,
      best: { poiName: "羊卓雍错", poiId: 82105 }, candidates: [candidate("羊卓雍错", "山南", "西藏", 82105)] },
    checkAvailability: async id => { checked = id; return { status: "available" }; },
  });
  assert.equal(result.status, "available");
  assert.equal(checked, 82105);
  for (const wrong of [candidate("吉古日", "山南", "西藏"), candidate("羊卓雍错", "拉萨", "西藏"),
    candidate("羊卓雍错", "山南", "四川")]) {
    assert.equal(isPlanningPoiCandidateInContext(wrong, context, product, "羊卓雍湖"), false);
  }
  assert.equal(isPlanningPoiCandidateInContext(candidate("羊卓雍错", "山南", "西藏"), context, {}, "羊卓雍湖"), false);
});
