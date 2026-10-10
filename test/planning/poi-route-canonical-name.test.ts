import test from "node:test";
import assert from "node:assert/strict";
import { isPlanningPoiCandidateInContext, resolvePlanningPoiAutoSelection } from "../../src/main/planning/poi-auto-selection.js";

const context = { destinationCity: "西宁", province: "青海" };
const cases = [
  ["青海湖", "青海湖景区", "湖边拍摄"],
  ["大柴旦翡翠湖", "大柴旦翡翠湖旅游景区", "翡翠湖游览"],
  ["水上雅丹", "乌素特水上雅丹地质公园", "抵达乌素特水上雅丹游览"],
];
for (const [keyword, poiName, description] of cases) {
  test(`原始路线 ${keyword} 接受当前同省唯一官方名称，不改变城市锚点`, async () => {
    const item = { index: 0, poiName, poiId: 123, province: "青海", city: "海西", district: "格尔木", selectable: true, textFields: [] };
    const product = { basicInfo: { ...context, userIdea: `D1：西宁-${keyword}` }, itinerary: [{ spots: [{ name: keyword }], description }] };
    const args = { localProductId: "new", keyword, product, context,
      detail: { httpStatus: 200, businessStatus: "Success", poiListCount: 1, best: item, candidates: [item] },
      checkAvailability: async () => ({ status: "available" as const }) };
    assert.equal((await resolvePlanningPoiAutoSelection(args)).match?.poiId, 123);
    assert.equal(product.basicInfo.destinationCity, "西宁");
    assert.equal(isPlanningPoiCandidateInContext(item, context, product, keyword, [item, { ...item, poiId: 456 }]), false);
    assert.equal(isPlanningPoiCandidateInContext({ ...item, province: "云南" }, context, product, keyword, [item]), false);
    assert.equal(isPlanningPoiCandidateInContext(item, context, { ...product, basicInfo: { ...context, userIdea: "西宁游览" } }, keyword, [item]), false);
    assert.equal((await resolvePlanningPoiAutoSelection({ ...args, checkAvailability: async () => ({ status: "suspended" }) })).status, "suspended");
  });
}

test("夜拍所在景点的设施和拍摄服务不成为唯一主景点候选", () => {
  const product = { basicInfo: { userIdea: "青海湖" }, itinerary: [{ spots: [{ name: "青海湖" }], description: "青海湖拍摄" }] };
  for (const poiName of ["青海湖停车场", "青海湖旅游拍摄", "青海湖二郎剑景区"]) {
    const item = { index: 0, poiName, poiId: 1, province: "青海", city: "海西", selectable: true, textFields: [] };
    assert.equal(isPlanningPoiCandidateInContext(item, context, product, "青海湖", [item]), false);
  }
});
