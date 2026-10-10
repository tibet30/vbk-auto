import test from "node:test";
import assert from "node:assert/strict";
import { hotelStayRequirement } from "../../src/shared/hotel-stay-requirement.js";
import { reconcileHotelStays } from "../../src/shared/reconcile-hotel-stays.js";
import { extraPreparationGaps } from "../../src/main/planning/preparation-checks.js";
import { reusableHotelCandidates, reusableHotelCandidatesFromPool } from "../../src/main/infrastructure/ctrip-hotel-candidate-cache.js";
import { rankCtripHotelCandidates } from "../../src/main/infrastructure/ctrip-hotel-list-parser.js";
import { resolveItineraryHotelCandidates } from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { agentPatchOperations, applyPersistedHotelTierChoices } from "../../src/main/agent/integration-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const farHotel = { hotelId: 7007077, hotelName: "洋县梨园农庄", diamond: 3, score: 3.6, distanceKm: 37.77,
  cityName: "洋县", anchorName: "华阳古镇", anchorCityId: 1920 };
const fixture = () => ({ basicInfo: { userIdea: "4-留侯---华阳古镇---住华阳古镇", days: 4, nights: 4 },
  operations: { hotelTier: "当地3钻酒店/-3" }, itinerary: [{ day: 4, title: "华阳古镇", hotel: farHotel.hotelName,
    hotelDescription: "优先入住洋县梨园农庄", spots: [], hotelCandidates: [farHotel] }] });

test("住宿字段缺少行政区时，使用住宿前最近的行政地点而不是旧城市", () => {
  const product = {
    basicInfo: {
      userIdea: "3-太白县---留坝县美食---张良庙---留侯住宿;\n5-华阳---佛坪---汉中---住汉中",
    },
  };
  assert.equal(hotelStayRequirement(product, {
    day: 3,
    hotel: "留侯镇当地民宿/5钻酒店",
    hotelRequirement: { cityName: "汉中" },
  })?.cityName, "留坝");
  assert.equal(hotelStayRequirement(product, {
    day: 5,
    hotel: "汉中市区当地5钻酒店",
    hotelRequirement: { cityName: "西安" },
  })?.cityName, "汉中");
  assert.deepEqual(hotelStayRequirement(product, {
    day: 3,
    hotel: "留侯镇当地民宿/5钻酒店",
  })?.ratingAlternatives, [{ ratingType: "diamond" }, { ratingType: "homestay" }]);
});

test("新产品可以复用历史产品同一落脚点的已核验候选", () => {
  const candidate = { hotelId: 122756354, hotelName: "隐筑花涧庭院民宿", diamond: 3, score: 4.8,
    distanceKm: 1.24, cityName: "留坝", anchorName: "留侯古镇", anchorCityId: 21367, ratingType: "homestay" as const };
  const requirement = { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5,
    ratingAlternatives: [{ ratingType: "diamond" as const }, { ratingType: "homestay" as const }] };
  assert.deepEqual(reusableHotelCandidatesFromPool([candidate], "当地5钻酒店", requirement), [candidate]);
});

test("酒店解析器命中历史候选时不再重新请求携程，并把候选写回当前日", async () => {
  const candidate = { hotelId: 122756354, hotelName: "隐筑花涧庭院民宿", diamond: 3, score: 4.8,
    distanceKm: 1.24, cityName: "留坝", anchorName: "留侯古镇", anchorCityId: 21367, ratingType: "homestay" as const };
  const requirement = { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5,
    ratingAlternatives: [{ ratingType: "diamond" as const }, { ratingType: "homestay" as const }] };
  const result = await resolveItineraryHotelCandidates(
    [{ day: 3, hotel: "留侯镇当地民宿/5钻酒店", spots: [] }], "西安", 5, "当地5钻酒店", undefined,
    new Map([[3, requirement]]), true, [candidate],
  );
  assert.equal(result.itinerary[0]!.hotel, candidate.hotelName);
  assert.deepEqual(result.dailyCandidates[0]!.candidates, [candidate]);
});

test("查询、缓存、准备检查和统一写入都拒绝同县37公里外的华阳住宿", () => {
  const product = fixture();
  const requirement = hotelStayRequirement(product, product.itinerary[0])!;
  assert.equal(requirement.anchorName, "华阳古镇");
  assert.equal(requirement.maxDistanceKm, 5);
  assert.equal(reusableHotelCandidates(product.itinerary[0], product.operations.hotelTier, requirement), undefined);
  assert.ok(extraPreparationGaps(product).some(gap => gap.label === "酒店候选：第 4 天"));
  const next = reconcileHotelStays(product);
  const day = (next.itinerary as Array<Record<string, unknown>>)[0];
  assert.deepEqual(day.hotelCandidates, []);
  assert.match(String(day.hotel), /华阳古镇.*待核验/);
  assert.doesNotMatch(String(day.hotel), /梨园/);
  assert.equal(reconcileHotelStays(next).itinerary instanceof Array, true);
});

test("民宿圆钻必须保留类型，只能在明确接受民宿时作为候选", () => {
  const row = { hotelInfo: { summary: { hotelId: 122756354 }, nameInfo: { name: "隐筑花涧庭院民宿" },
    hotelStar: { star: 3, starType: 2 }, commentInfo: { commentScore: 4.8 },
    positionInfo: { cityId: 21367, cityName: "留坝", mapCoordinate: [{ latitude: 33.69, longitude: 106.85 }] } } };
  const anchor = { id: "19320520", cityId: 21367, cityName: "留坝", name: "留侯古镇", coordinate: { latitude: 33.69, longitude: 106.85 } };
  assert.throws(() => rankCtripHotelCandidates([row], anchor, "当地3钻酒店"));
  const accepted = rankCtripHotelCandidates([row], { ...anchor, requirement: { anchorName: "留侯", ratingType: "homestay", maxDistanceKm: 5 } }, "当地3钻酒店");
  assert.equal(accepted[0].ratingType, "homestay");
  assert.equal(accepted[0].diamond, 3);
});

test("降档只查询原住宿地，按晚保存实际评级和原因，未开启或网络失败不降档", async () => {
  const originalFetch = globalThis.fetch;
  const queries: number[] = [];
  let networkFailure = false;
  let onlyLowestGrade = false;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("gaHotelSearchEngine")) return Response.json({ Response: { searchResults: [
      { id: "49085457", cityId: 1920, cityName: "洋县", word: "华阳古镇", type: "Markland", gLat: 33.59, gLon: 107.54 },
    ] } });
    if (networkFailure) return new Response("offline", { status: 503 });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("searchType"), "LM");
    assert.match(parsed.searchParams.get("searchWord")!, /华阳/);
    const grade = Number(parsed.searchParams.get("listFilters")!.match(/16~(\d)/)?.[1]);
    queries.push(grade);
    const hotelList = [{ hotelInfo: { summary: { hotelId: grade === 3 ? 7007077 : 134934940 },
      nameInfo: { name: grade === 3 ? "远处民宿" : "禾庭民宿" }, hotelStar: { star: grade, starType: 2 },
      commentInfo: { commentScore: 4.8 }, positionInfo: { cityId: 1920, cityName: "洋县",
        mapCoordinate: [{ latitude: (onlyLowestGrade ? grade !== 1 : grade === 3) ? 33.1 : 33.59, longitude: 107.54 }] } } }];
    return new Response(`<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initListData: { hotelList } })])})</script>`);
  };
  const days = [{ day: 4, hotel: "洋县华阳古镇内特色客栈", spots: [] }];
  const requirements = new Map([[4, { anchorName: "华阳古镇", cityName: "洋", maxDistanceKm: 5, ratingType: "homestay" as const }]]);
  try {
    await assert.rejects(resolveItineraryHotelCandidates(days, "西安", 5, "当地3钻酒店", undefined, requirements), /未完成/);
    assert.deepEqual(queries, [3]);
    queries.length = 0;
    const result = await resolveItineraryHotelCandidates(days, "西安", 5, "当地3钻酒店", undefined, requirements, true);
    assert.deepEqual(queries, [3, 2]);
    assert.equal(result.dailyCandidates[0].candidates[0].diamond, 2);
    assert.match(String(result.itinerary[0].hotelDescription), /目标3钻.*改为2钻/);
    assert.equal((result.itinerary[0].hotelRequirement as Record<string, unknown>).diamond, 2);
    queries.length = 0;
    onlyLowestGrade = true;
    const lowest = await resolveItineraryHotelCandidates(days, "西安", 5, "当地5钻酒店", undefined, requirements, true);
    assert.deepEqual(queries, [5, 4, 3, 2, 1]);
    assert.equal(lowest.dailyCandidates[0].candidates[0].diamond, 1);
    networkFailure = true;
    await assert.rejects(resolveItineraryHotelCandidates(days, "西安", 5, "当地3钻酒店", undefined, requirements, true), /503/);
    assert.deepEqual(queries, [5, 4, 3, 2, 1]);
  } finally { globalThis.fetch = originalFetch; }
});

test("模型不能未经明确逐日选择伪造住宿降档", () => {
  const detail = { product: { operations: { hotelTier: "当地3钻酒店/-3" }, itinerary: [{ day: 4, spots: [], hotel: "华阳客栈" }] }, messages: [] } as unknown as ProductDetail;
  const patch = { itinerary: [{ day: 4, hotelRequirement: { anchorName: "华阳古镇", diamond: 2, ratingType: "homestay" } }] };
  assert.throws(() => agentPatchOperations(detail, patch, { hotelTierInstruction: "继续当前规划" }), /评级变更必须/);
  assert.doesNotThrow(() => agentPatchOperations(detail, patch, { hotelTierInstruction: "D4 使用2钻客栈" }));
});

test("结构化 ask_user 的逐日酒店降档回答可通过校验", () => {
  const detail = { product: { operations: {}, itinerary: [
    { day: 3, spots: [], hotel: "留坝酒店", hotelRequirement: { diamond: 5, ratingType: "diamond" } },
    { day: 4, spots: [], hotel: "华阳酒店", hotelRequirement: { diamond: 5, ratingType: "diamond" } },
  ] }, messages: [] } as unknown as ProductDetail;
  const patch = { itinerary: [
    { day: 3, hotelRequirement: { diamond: 4, ratingType: "diamond" } },
    { day: 4, hotelRequirement: { diamond: 4, ratingType: "diamond" } },
  ] };
  const answer = "继续当前本地规划。结构化确认：{\"day3hotel_diamond\":\"降为4钻（当地优质酒店，保留留侯住宿地点）\",\"day4hotel_diamond\":\"降为4钻（当地优质酒店，保留华阳住宿地点）\"}";
  assert.doesNotThrow(() => agentPatchOperations(detail, patch, { hotelTierInstruction: answer }));
});

test("酒店解析恢复前确定性应用已持久化的逐日降档回答", () => {
  const product = { itinerary: [
    { day: 3, hotelRequirement: { anchorName: "留侯", cityName: "留坝", diamond: 5 }, spots: [{ name: "张良庙" }] },
    { day: 4, hotelRequirement: { anchorName: "华阳古镇", diamond: 5 }, spots: [{ name: "华阳古镇", city: "汉中", district: "洋县" }] },
  ] };
  const answer = "继续：{\"day3hotel_diamond\":\"降为4钻并放宽距离到10km（当地优质酒店）\",\"day4hotel_diamond\":\"降为4钻，放宽距离到10km（当地优质酒店）\"}";
  const next = applyPersistedHotelTierChoices(product, answer);
  assert.deepEqual(next.itinerary, [
    { day: 3, hotelRequirement: { anchorName: "留侯", cityName: "留坝", diamond: 4, ratingType: "diamond", maxDistanceKm: 10 }, spots: [{ name: "张良庙" }] },
    { day: 4, hotelRequirement: { anchorName: "华阳古镇", diamond: 4, ratingType: "diamond", cityName: "洋县", maxDistanceKm: 10 }, spots: [{ name: "华阳古镇", city: "汉中", district: "洋县" }] },
  ]);
});

test("同一日期有多次住宿回答时，最新的改住市区决定覆盖旧锚点", () => {
  const product = { itinerary: [
    { day: 3, hotelRequirement: { anchorName: "留侯", cityName: "留坝", diamond: 5, maxDistanceKm: 5 }, spots: [{ name: "张良庙" }] },
    { day: 4, hotelRequirement: { anchorName: "华阳古镇", cityName: "洋县", diamond: 5, maxDistanceKm: 5 }, spots: [{ name: "华阳古镇", city: "汉中", district: "洋县" }] },
  ] };
  const answer = [
    '用户回答：{"day3hotel":"保留留侯镇住宿地点，继续降档为4钻并放宽距离到10km","day4hotel":"保留华阳古镇住宿地点（4钻，放宽距离到10km）"}',
    '用户回答：{"day3hotel":"改住汉中市区4钻（保留当日游玩的张良庙及留坝美食）","day4hotel":"改住汉中市区4钻（保留当日游玩的城固张骞故里与华阳古镇/四宝园）"}',
  ].join("\n");
  const next = applyPersistedHotelTierChoices(product, answer);
  assert.deepEqual(next.itinerary, [
    { day: 3, hotelRequirement: { anchorName: "汉中", cityName: "汉中", diamond: 4, ratingType: "diamond" }, spots: [{ name: "张良庙" }] },
    { day: 4, hotelRequirement: { anchorName: "汉中", cityName: "汉中", diamond: 4, ratingType: "diamond" }, spots: [{ name: "华阳古镇", city: "汉中", district: "洋县" }] },
  ]);
  const reconciled = reconcileHotelStays({ basicInfo: { userIdea: "3-留侯住宿;4-华阳古镇住宿" }, ...next });
  assert.deepEqual(reconciled.itinerary.map((day) => day.hotelRequirement), [
    { anchorName: "汉中", cityName: "汉中", diamond: 4, ratingType: "diamond" },
    { anchorName: "汉中", cityName: "汉中", diamond: 4, ratingType: "diamond" },
  ]);
});

test("hotelN 单选数组能恢复降档，多选和其他日期不能授权", () => {
  const product = { itinerary: [
    { day: 3, hotelRequirement: { diamond: 5, ratingType: "diamond" }, spots: [] },
    { day: 4, hotelRequirement: { diamond: 5, ratingType: "diamond" }, spots: [] },
  ] };
  const answer = '用户回答：{"hotel3":["保留5钻酒店","降为4钻酒店"],"hotel4":["允许降为洋县华阳古镇当地4钻，由系统按降档重新核验"]}';
  const next = applyPersistedHotelTierChoices(product, answer) as typeof product;
  assert.equal(next.itinerary[0].hotelRequirement.diamond, 5);
  assert.equal(next.itinerary[1].hotelRequirement.diamond, 4);
  const detail = { product, messages: [] } as unknown as ProductDetail;
  assert.doesNotThrow(() => agentPatchOperations(detail, { itinerary: [{ day: 4, hotelRequirement: { diamond: 4, ratingType: "diamond" } }] }, { hotelTierInstruction: answer }));
  assert.throws(() => agentPatchOperations(detail, { itinerary: [{ day: 3, hotelRequirement: { diamond: 4, ratingType: "diamond" } }] }, { hotelTierInstruction: answer }), /评级变更必须/);
  assert.equal(applyPersistedHotelTierChoices(product, '用户回答：{"hotel40":["降为4钻酒店"]}'), product);
});

test("后续日期核验失败时仍提交已复用候选的进度", async () => {
  const candidate = { hotelId: 136003100, hotelName: "绿景铂越酒店", diamond: 4, score: 0,
    distanceKm: 1.54, cityName: "太白县", anchorName: "太白县咀头镇人民政府", anchorCityId: 21821, ratingType: "diamond" as const };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("offline", { status: 503 });
  const progress: number[][] = [];
  try {
    await assert.rejects(resolveItineraryHotelCandidates([
      { day: 2, hotel: candidate.hotelName, hotelCandidates: [candidate], spots: [] },
      { day: 3, hotel: "留侯酒店", spots: [] },
    ], "西安", 5, "当地5钻酒店", result => { progress.push(result.dailyCandidates.map(row => row.day)); }, new Map([
      [2, { anchorName: "太白县咀头镇", cityName: "太白", maxDistanceKm: 5, diamond: 4, ratingType: "diamond" as const }],
      [3, { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5 }],
    ])), /第 3 天住宿.*503/);
    assert.deepEqual(progress, [[2]]);
  } finally { globalThis.fetch = originalFetch; }
});
