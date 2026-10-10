import test from "node:test";
import assert from "node:assert/strict";
import { hotelStayRequirement } from "../../src/shared/hotel-stay-requirement.js";
import { normaliseItinerary } from "../../src/main/data/product-normalize.js";
import { selectCtripHotelContext, resolveItineraryHotelCandidates } from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { agentPatchOperations, applyPersistedHotelTierChoices } from "../../src/main/agent/integration-patch.js";
import { hotelDowngradePermission } from "../../src/shared/hotel-downgrade-policy.js";
import { reconcileHotelCopy } from "../../src/shared/hotel-copy-consistency.js";
import { hasValidVbkRecommendationLength } from "../../src/main/planning/vbk-recommendation-length.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

test("已核验POI区县保存后仍能推断华阳住宿城市，纠正旧的西安锚点", () => {
  const [day] = normaliseItinerary([{ day: 4, hotel: "华阳住宿", hotelRequirement: { anchorName: "华阳古镇", cityName: "西安", maxDistanceKm: 10 },
    spots: [{ name: "华阳古镇", poiName: "华阳古镇", poiId: 112647382, city: "汉中", district: "洋县", province: "陕西" }] }])!;
  assert.equal((day.spots[0] as any).district, "洋县");
  const requirement = hotelStayRequirement({ basicInfo: { meetingCity: "西安", userIdea: "4-华阳古镇---住华阳古镇" } }, day)!;
  assert.equal(requirement.cityName, "洋");
  assert.equal(requirement.maxDistanceKm, 10);
});

const context = (cityId: number, cityName: string) => ({ id: String(cityId), word: "华阳古镇", cityId, cityName, gLat: 33.59, gLon: 107.54, type: "Markland" });
test("未知行政城市按官方唯一地标解析，跨城市同名拒绝猜测", () => {
  assert.equal(selectCtripHotelContext([context(1920, "洋县")], { anchorName: "华阳古镇" }).cityName, "洋县");
  assert.throws(() => selectCtripHotelContext([context(1920, "洋县"), context(28, "成都")], { anchorName: "华阳古镇" }), /多个城市同名/);
});

test("明确逐晚住宿锚点没有行政城市时，解析器不借用西安接团城市", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).includes("gaHotelSearchEngine")) return Response.json({ Response: { searchResults: [context(1920, "洋县")] } });
    assert.equal(new URL(String(input)).searchParams.get("cityId"), "1920");
    const hotelList = [{ hotelInfo: { summary: { hotelId: 131313778 }, nameInfo: { name: "华阳酒店" }, hotelStar: { star: 4, starType: 0 },
      commentInfo: { commentScore: 4.8 }, positionInfo: { cityId: 1920, cityName: "洋县", mapCoordinate: [{ latitude: 33.59, longitude: 107.54 }] } } }];
    return new Response(`<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initListData: { hotelList } })])})</script>`);
  };
  try {
    const result = await resolveItineraryHotelCandidates([{ day: 4, hotel: "华阳酒店", spots: [] }], "西安", 5, "当地4钻酒店", undefined,
      new Map([[4, { anchorName: "华阳古镇", maxDistanceKm: 5 }]]));
    assert.equal(result.dailyCandidates[0].candidates[0].cityName, "洋县");
  } finally { globalThis.fetch = original; }
});

const product = () => ({ itinerary: [{ day: 3, spots: [], hotelRequirement: { anchorName: "留侯", diamond: 5, ratingType: "diamond" } }] });
test("三圆钻民宿选择保留住宿地和类型；最新拒绝或多选不继承旧许可", () => {
  const chosen = applyPersistedHotelTierChoices(product(), '用户回答：{"hotel3":["接受三圆钻民宿，保留留侯"]}') as ReturnType<typeof product>;
  assert.deepEqual(chosen.itinerary[0].hotelRequirement, { anchorName: "留侯", diamond: 3, ratingType: "homestay" });
  const old = '{"hotel3":"降为4钻酒店"}\n';
  for (const newest of ['{"hotel3":"不要降为3钻酒店"}', '{"hotel3":["降为3钻酒店","保留5钻酒店"]}']) {
    const current = product();
    assert.equal(applyPersistedHotelTierChoices(current, old + newest), current);
  }
});

test("迭代降钻必须有用户许可，后续拒绝撤销，单日选择不授权其他日期", () => {
  assert.equal(hotelDowngradePermission("可以使用三转，我们可以迭代的降低钻级"), true);
  assert.equal(hotelDowngradePermission("允许降档\n不要降档"), false);
  assert.equal(hotelDowngradePermission("继续录入"), undefined);
  assert.equal(hotelDowngradePermission('{"hotel3":"允许降为3钻酒店"}'), undefined);
  const detail = { product: { operations: {}, ...product() }, messages: [] } as unknown as ProductDetail;
  const patch = { operations: { hotelFallbackPolicy: { allowDowngrade: true } } };
  assert.throws(() => agentPatchOperations(detail, patch, { hotelTierInstruction: "继续" }), /用户明确/);
  assert.doesNotThrow(() => agentPatchOperations(detail, patch, { hotelTierInstruction: "允许降档" }));
});

test("统一文案同步撤销与民宿圆钻冲突的全程5钻承诺，并保留其他安排", () => {
  const candidate = { hotelId: 122756354, hotelName: "隐筑花涧庭院民宿", diamond: 3, ratingType: "homestay", cityName: "留坝", anchorName: "留侯", distanceKm: 1.24 };
  const original = { basicInfo: { operationNotes: "全程当地5钻酒店；含接送站和早餐。" },
    presentation: { features: "<p>全程当地5钻酒店，沿途欣赏秦岭风光</p>", recommendations: [{ category: "精选酒店", text: "全程当地5钻酒店，兼顾每日行程衔接和舒适休息体验" }] },
    itinerary: [{ day: 3, hotel: candidate.hotelName, hotelCandidates: [candidate], hotelRequirement: { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5, diamond: 3, ratingType: "homestay" } }] };
  const next = reconcileHotelCopy(original) as typeof original;
  assert.doesNotMatch(JSON.stringify(next), /全程当地5钻/);
  assert.match(next.basicInfo.operationNotes, /含接送站和早餐/);
  assert.match(next.basicInfo.operationNotes, /第3晚3民宿圆钻/);
  assert.ok(hasValidVbkRecommendationLength(next.presentation.recommendations[0].text));
  assert.deepEqual(reconcileHotelCopy(next), next);
  assert.match(original.basicInfo.operationNotes, /全程当地5钻/);
});

test("酒店检索期间用户改变住宿地点或评级时，旧结果不能覆盖新要求", async () => {
  const { mergeResolvedHotelProgress } = await import("../../src/main/agent/integration-itinerary-hotel-result.js");
  const initial = [{ day: 4, hotel: "华阳酒店", hotelRequirement: { anchorName: "华阳古镇", diamond: 4 } }];
  const changed = { itinerary: [{ ...initial[0], hotelRequirement: { anchorName: "汉中", diamond: 5 } }] };
  const candidates = [{ hotelId: 131313778, hotelName: "华阳酒店", diamond: 4, score: 4.8, distanceKm: 0, anchorName: "华阳古镇", cityName: "洋县", anchorCityId: 1920 }];
  assert.throws(() => mergeResolvedHotelProgress(changed, initial, { itinerary: initial, dailyCandidates: [{ day: 4, candidates }], searchDates: { checkin: "2026-10-09", checkout: "2026-10-10" } }), /查询期间已改变/);
  assert.deepEqual(changed.itinerary[0].hotelRequirement, { anchorName: "汉中", diamond: 5 });
});

test("用户拒绝的评级即使出现在结构化回答里，也不能授权模型降档", () => {
  const detail = { product: product(), messages: [] } as unknown as ProductDetail;
  for (const instruction of ['{"hotel3":"拒绝降为3钻酒店"}', '{"hotel3":"不能降为三圆钻民宿"}']) {
    assert.throws(() => agentPatchOperations(detail, { itinerary: [{ day: 3, hotelRequirement: { diamond: 3, ratingType: instruction.includes("民宿") ? "homestay" : "diamond" } }] }, { hotelTierInstruction: instruction }), /评级变更必须/);
  }
});
