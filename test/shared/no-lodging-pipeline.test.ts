import test from "node:test";
import assert from "node:assert/strict";
import { hasItineraryHotelStay, needsItineraryHotelCandidates, NO_ITINERARY_HOTEL } from "../../src/shared/itinerary-hotel.js";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { reconcileHotelStays } from "../../src/shared/reconcile-hotel-stays.js";
import { resourceGaps } from "../../src/main/planning/preparation-checks/resources.js";
import { createHotelCandidateResolver } from "../../src/main/infrastructure/ctrip-hotel-search/resolve.js";
import { shouldResolveItineraryHotelForDay } from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { composePlanningSystemPrompt } from "../../src/main/planning/adapters/planning-prompt.js";
import { ITINERARY_LODGING_GUIDE } from "../../src/shared/itinerary-hotel.js";

const candidate = { hotelId: 101, hotelName: "汉中酒店", diamond: 5, score: 4.8,
  distanceKm: 1, cityName: "汉中", anchorName: "汉中", anchorCityId: 129 };
const variants = ["不含当晚住宿", "不含住宿", "返程当日不含住宿。", "当天不包含过夜住宿（汉中送站）", "当日不提供住宿", "无需当晚住宿"];
const returnDay = (hotel: string) => ({ day: 6, title: "汉中送机/送高铁", description: "从汉中酒店出发，送机或送高铁返程；返程当日不含住宿。",
  hotel, meals: "敬请自理", spots: [], activities: [{ time: "全天", title: "汉中送机/送高铁返程", detail: "按班次送站", type: "transport" }] });
const product = (hotel: string) => ({ basicInfo: { days: 6, nights: 5 }, sales: { productForm: "selfGuided" },
  operations: { hotelTier: "当地5钻酒店/-38", transport: "none" },
  itinerary: [...Array.from({ length: 5 }, (_, i) => ({ day: i + 1, title: "汉中游览", description: "游览后入住汉中酒店",
    hotel: candidate.hotelName, meals: "敬请自理", spots: [], hotelCandidates: [candidate] })), returnDay(hotel)] });

test("生成提示使用共享不住宿约定，明确保留末日接送及真实住宿", () => {
  assert.ok(composePlanningSystemPrompt("itinerary").includes(ITINERARY_LODGING_GUIDE));
});

test("明确不含当晚住宿：生成归一化、酒店查询和准备门禁共用同一判断", async () => {
  assert.equal(shouldResolveItineraryHotelForDay, needsItineraryHotelCandidates);
  for (const wording of variants) {
    const raw = product(wording);
    assert.equal(hasItineraryHotelStay(wording), false, wording);
    assert.equal(shouldResolveItineraryHotelForDay(raw.itinerary[5]!, 5, 5), false, wording);
    assert.deepEqual(resourceGaps(raw).filter(g => g.code === "hotel"), [], wording);
    const generated = normaliseProductDraft(raw);
    const persisted = reconcileHotelStays(generated);
    const days = persisted.itinerary as Array<Record<string, unknown>>;
    assert.equal(days[5]!.hotel, NO_ITINERARY_HOTEL);
    assert.equal(days.length, 6);
    assert.deepEqual(days[5]!.activities, raw.itinerary[5]!.activities);
    assert.equal(days[5]!.meals, "敬请自理");
    let queries = 0;
    const resolver = createHotelCandidateResolver(async () => { queries++; throw new Error("不住宿日禁止查询酒店"); });
    // Also exercise raw model wording, before normalization, through the production resolver.
    const matched = await resolver(raw.itinerary, "汉中", 5, "当地5钻酒店/-38");
    assert.equal(queries, 0);
    assert.deepEqual(matched.dailyCandidates.map(d => d.day), [1, 2, 3, 4, 5]);
    assert.equal(matched.itinerary.length, 6);
    assert.deepEqual(resourceGaps({ ...raw, itinerary: matched.itinerary }).filter(g => g.code === "hotel"), []);
  }
});

test("不住宿标记撤回残留要求、候选和资源镜像，不能被保存修复恢复成酒店", () => {
  const raw = product("不含当晚住宿");
  Object.assign(raw.itinerary[5]!, { hotelRequirement: { anchorName: "汉中", cityName: "汉中", diamond: 5 }, hotelCandidates: [candidate] });
  Object.assign(raw.operations, { hotelResource: { resourceId: 101, dailyCandidates: raw.itinerary.map(day => ({ day: day.day, candidates: [candidate] })) } });
  for (const input of [raw, normaliseProductDraft(raw)]) {
    const next = reconcileHotelStays(input);
    const day = (next.itinerary as Array<Record<string, unknown>>)[5]!;
    assert.equal(day.hotel, NO_ITINERARY_HOTEL);
    assert.equal(day.hotelCandidates, undefined);
    assert.equal(day.hotelRequirement, undefined);
    const mirror = (next.operations as any).hotelResource.dailyCandidates;
    assert.deepEqual(mirror.map((entry: any) => entry.day), [1, 2, 3, 4, 5]);
    assert.deepEqual(reconcileHotelStays(next), next);
  }
});

test("真实酒店、自理住宿及前五晚缺候选仍须通过住宿门禁", () => {
  for (const wording of ["汉中酒店", "无锡君来洲际酒店", "返程驿站酒店", "住宿自理", "敬请自理"]) {
    assert.equal(hasItineraryHotelStay(wording), true);
    const raw = product(wording);
    assert.equal(shouldResolveItineraryHotelForDay(raw.itinerary[5]!, 5, 5), true);
    assert.ok(resourceGaps(raw).some(g => g.label === "酒店候选：第 6 天"));
  }
  const raw = product("不含当晚住宿");
  delete (raw.itinerary[2]! as any).hotelCandidates;
  assert.deepEqual(resourceGaps(raw).filter(g => g.code === "hotel").map(g => g.label), ["酒店候选：第 3 天"]);
});
