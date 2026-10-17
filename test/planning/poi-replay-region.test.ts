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

test("用户指定的冰川观察名只接受同省唯一同实体官方主 POI", async () => {
  const context = { destinationCity: "拉萨", province: "西藏" };
  const cases = [
    ["羊卓雍措", "羊卓雍错", "山南"],
    ["库拉岗日冰川", "库拉岗日雪山", "山南"],
    ["希夏邦马峰冰川群", "希夏邦马峰", "日喀则"],
    ["冈仁波齐山体冰川遗迹", "冈仁波齐", "阿里"],
    ["扎达土林", "札达土林国家地质公园‌", "阿里"],
  ] as const;
  for (const [requested, official, city] of cases) {
    const product = { basicInfo: { userIdea: `D1：${requested}`, province: "西藏" },
      itinerary: [{ day: 1, title: requested, spots: [{ name: requested }] }] };
    const only = candidate(official, city, "西藏", 10);
    assert.equal(isPlanningPoiCandidateInContext(only, context, product, requested, [only]), true);
    const result = await resolvePlanningPoiAutoSelection({
      localProductId: "identity-core", keyword: requested, product, context,
      detail: { httpStatus: 200, businessStatus: "Success", poiListCount: 1, best: null, candidates: [only] },
      checkAvailability: async () => ({ status: "available" }),
      disambiguate: async () => { throw new Error("同省唯一同实体不应交给模型重复消歧"); },
    });
    assert.deepEqual(result.match, { poiName: official, poiId: 10, province: "西藏", city });
    assert.equal(isPlanningPoiCandidateInContext(candidate("藏北大草原", "那曲", "西藏", 11),
      context, product, requested, [only]), false);
  }
});
