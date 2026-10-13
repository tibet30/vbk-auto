import test from "node:test";
import assert from "node:assert/strict";
import { resolveItineraryHotelCandidates } from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { parseHotelDetail } from "../../src/main/infrastructure/ctrip-hotel-search/detail.js";
import { resourceGaps } from "../../src/main/planning/preparation-checks/resources.js";
import { createItineraryHotelTool } from "../../src/main/agent/integration-itinerary-hotel-tool.js";

const id = 55195528;
const suggestion = { id: String(id), type: "Hotel", word: "麗枫酒店(广安思源广场店)", cityId: 1100, cityName: "广安", countryId: 1, gLat: 0, gLon: 0 };
function detailHtml(changes: Record<string, unknown> = {}) {
  const data = { hotelDetailResponse: {
    hotelBaseInfo: { masterHotelId: id, nameInfo: { name: suggestion.word }, cityId: 1100, cityName: "广安", countryId: 1,
      starInfo: { level: 3, type: "diamond" }, ...changes },
    hotelPositionInfo: { lat: "30.461245", lng: "106.642209", mapType: "bd", address: "广安金安大道" },
    hotelComment: { comment: { score: "4.5" } },
  } };
  return `<script>self.__next_f.push(${JSON.stringify([1, `J0:${JSON.stringify(data)}`])})</script>`;
}
function replay(options: { rows?: unknown[]; detail?: string; missingDetail?: boolean } = {}) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("gaHotelSearchEngine")) {
      requests.push(JSON.parse(String(init?.body)).keyword);
      return Response.json({ Response: { searchResults: options.rows ?? [suggestion, { ...suggestion, id: "18550911", cityId: 1, cityName: "北京" }] } });
    }
    assert.equal(url, `https://hotels.ctrip.com/hotels/${id}.html`, "only the verified property detail may be queried");
    requests.push(`detail:${id}`);
    if (options.missingDetail) throw new Error("missing replay detail");
    return new Response(options.detail ?? detailHtml());
  };
  return { requests, fetcher };
}
const day = { day: 1, hotel: "丽枫酒店（广安）", description: "入住丽枫酒店", spots: [{ name: "白塔公园", city: "广安" }] };

test("新产品生成的住宿叙述只提取酒店名，保留城市和分店，不将住宿一晚作为检索词", async () => {
  for (const hotel of ["丽枫酒店（广安）住宿一晚", "入住丽枫酒店（广安），住宿1晚。", "下榻丽枫酒店（广安）住两晚"]) {
    const { fetcher, requests } = replay();
    const result = await resolveItineraryHotelCandidates([{ ...day, hotel }], "广安", 1,
      "当地5钻酒店", undefined, undefined, true, [], fetcher);
    assert.deepEqual(requests, ["丽枫酒店（广安）", `detail:${id}`]);
    assert.equal(result.dailyCandidates[0]!.candidates[0]!.hotelId, id);
    assert.equal(resourceGaps({ basicInfo: { meetingCity: "广安", nights: 1 }, operations: { hotelTier: "当地5钻酒店" }, itinerary: result.itinerary }).length, 0);
  }
});

test("指定酒店用既有城市与名称取得身份，再从详情补齐缺坐标和评级并按许可降档", async () => {
  const { fetcher, requests } = replay();
  const checkpoints: unknown[] = [];
  const result = await resolveItineraryHotelCandidates([day, { day: 2, hotel: "无当日住宿安排" }], "广安", 1,
    "当地5钻酒店", value => { checkpoints.push(structuredClone(value)); }, undefined, true, [], fetcher);
  assert.deepEqual(requests, ["丽枫酒店（广安）", `detail:${id}`]);
  assert.equal(checkpoints.length, 1);
  assert.equal(result.dailyCandidates.length, 1);
  assert.equal(result.dailyCandidates[0]!.candidates[0]!.hotelId, id);
  assert.equal(result.dailyCandidates[0]!.candidates[0]!.diamond, 3);
  assert.equal(result.dailyCandidates[0]!.candidates[0]!.distanceKm, 0);
  assert.match(String(result.itinerary[0]!.hotelDescription), /目标5钻.*允许降档.*3钻/);
  assert.equal(resourceGaps({ basicInfo: { meetingCity: "广安", nights: 1 }, operations: { hotelTier: "当地5钻酒店" }, itinerary: result.itinerary }).length, 0);
  assert.equal(day.hotel, "丽枫酒店（广安）", "resolver must preserve the source until persistence");
});

test("禁止降档时明确显示5钻要求、3钻实际值和不等式，不保存候选", async () => {
  const { fetcher } = replay(); let saves = 0;
  await assert.rejects(resolveItineraryHotelCandidates([day], "广安", 1, "当地5钻酒店", () => { saves += 1; }, undefined, false, [], fetcher),
    /要求5钻.*为3钻.*3≠5.*禁止降档.*实际本日保存0个/);
  assert.equal(saves, 0);
});

test("多分店歧义与酒店详情跨城不能靠缺坐标修复放行", async () => {
  const ambiguous = replay({ rows: [suggestion, { ...suggestion, id: "123" }] });
  await assert.rejects(resolveItineraryHotelCandidates([day], "广安", 1, "当地5钻酒店", undefined, undefined, true, [], ambiguous.fetcher), /同城同名有效酒店2家.*多个分店/);
  assert.equal(ambiguous.requests.length, 1, "ambiguous properties cannot be chosen arbitrarily");
  const wrong = replay({ detail: detailHtml({ cityName: "北京", cityId: 1 }) });
  await assert.rejects(resolveItineraryHotelCandidates([day], "广安", 1, "当地5钻酒店", undefined, undefined, true, [], wrong.fetcher), /要求酒店ID=55195528、城市=广安.*城市=北京/);
});

test("详情身份、坐标、评分和评级必须真实且完整，缺失回放不降级", async () => {
  for (const html of [detailHtml({ masterHotelId: 1 }), detailHtml({ starInfo: { level: 3, type: "star" } }), detailHtml({ starInfo: { level: null, type: "diamond" } }),
    detailHtml().replace('\\"lat\\":\\"30.461245\\"', '\\"lat\\":\\"0\\"'),
    detailHtml().replace('\\"score\\":\\"4.5\\"', '\\"score\\":null')]) {
    const { fetcher } = replay({ detail: html });
    await assert.rejects(resolveItineraryHotelCandidates([day], "广安", 1, "当地5钻酒店", undefined, undefined, true, [], fetcher));
  }
  const { fetcher } = replay({ missingDetail: true });
  await assert.rejects(resolveItineraryHotelCandidates([day], "广安", 1, "当地5钻酒店", undefined, undefined, true, [], fetcher), /missing replay detail/);
  assert.deepEqual(parseHotelDetail(detailHtml(), id, "广安").coordinate, { latitude: 30.461245, longitude: 106.642209 });
});

test("住宿门禁分别列出目标评级、实际评级、距离超限和缺失字段", () => {
  const candidate = parseHotelDetail(detailHtml(), id, "广安").candidate;
  const product = { basicInfo: { meetingCity: "广安", nights: 1 }, operations: { hotelTier: "当地5钻酒店", hotelFallbackPolicy: { allowDowngrade: false } },
    itinerary: [{ ...day, hotelRequirement: { anchorName: candidate.anchorName, cityName: "广安", diamond: 5, maxDistanceKm: 5 },
      hotelCandidates: [{ ...candidate, distanceKm: 8, score: undefined }] }] };
  const [gap] = resourceGaps(product);
  assert.match(gap!.detail, /要求：广安，5钻.*距离≤5km.*已保存1个.*检查0个/);
  assert.match(gap!.detail, /实际3钻≠要求5钻/);
  assert.match(gap!.detail, /实际距离8km＞允许5km/);
  assert.match(gap!.detail, /缺少字段score.*禁止/);
});

test("普通地标失败后用已知城市前缀恢复，城市建议缺坐标不当成无酒店", async () => {
  const queries: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("gaHotelSearchEngine")) {
      const keyword = JSON.parse(String(init?.body)).keyword; queries.push(keyword);
      const rows = keyword === "广安白塔公园" ? [{ id: "55421165", type: "Markland", word: "白塔公园", cityId: 1100, cityName: "广安", gLat: 30.466, gLon: 106.659 }]
        : keyword === "广安" ? [{ id: "1100", type: "City", cityId: 1100, cityName: "广安", word: "广安" }]
        : [{ id: "other", cityId: 17, cityName: "杭州", word: "白塔公园", gLat: 30.1, gLon: 120.1 }];
      return Response.json({ Response: { searchResults: rows } });
    }
    const row = { hotelInfo: { summary: { hotelId: id }, nameInfo: { name: suggestion.word }, hotelStar: { star: 3, starType: 0 }, commentInfo: { commentScore: 4.5 },
      positionInfo: { cityId: 1100, cityName: "广安", mapCoordinate: [{ latitude: 30.46, longitude: 106.64 }] } } };
    return new Response(`<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initListData: { hotelList: [row] } })])})</script>`);
  };
  const result = await resolveItineraryHotelCandidates([{ ...day, hotel: "当地3钻酒店" }], "广安", 1, "当地3钻酒店", undefined, undefined, false, [], fetcher);
  assert.deepEqual(queries, ["白塔公园", "广安", "广安白塔公园"]);
  assert.equal(result.dailyCandidates[0]!.candidates[0]!.hotelId, id);
});

test("生产酒店工具持久化详情核验结果，重新读取后住宿门禁通过", async () => {
  let current: any = { id: "local", status: "planning", product: { basicInfo: { destinationCity: "广安", meetingCity: "广安", nights: 1 },
    operations: { hotelTier: "当地5钻酒店", hotelFallbackPolicy: { allowDowngrade: true } }, itinerary: [structuredClone(day)] } };
  const { fetcher } = replay();
  const deps: any = { db: { listProducts: () => [], getAgentSnapshot: () => ({ events: [] }) }, resourceQueries: { hotelFetch: fetcher },
    productMutations: { commands: { mergeChanges: (_id: string, _baseline: unknown, product: unknown) => (current = structuredClone({ ...current, product })) } } };
  const receipt = await createItineraryHotelTool(deps, () => structuredClone(current)).execute({}, { localProductId: "local" } as any);
  assert.equal(JSON.parse(receipt.content).persisted, true);
  assert.equal(current.product.itinerary[0].hotelCandidates, undefined);
  assert.equal(current.product.itinerary[0].hotelRequirement, undefined);
  assert.deepEqual(current.product.operations.hotelRules, { autoMatch: true, grades: [3, 4, 5] });
  assert.equal(resourceGaps(structuredClone(current.product)).length, 0);
});
