import test from "node:test";
import assert from "node:assert/strict";
import { isPlanningPoiCandidateInContext, resolvePlanningPoiAutoSelection } from "../../src/main/planning/poi-auto-selection.js";

test("程序无法确定时只交前 12 条给 AI，营业正常且置信度高于 80% 后返回可写入的候选", async () => {
  const candidates = Array.from({ length: 13 }, (_, index) => ({
    index: index + 1,
    poiName: `候选${index + 1}`,
    poiId: 1000 + index,
    province: "西藏",
    city: "日喀则",
    selectable: true,
    textFields: [],
  }));
  const events: string[] = [];
  const result = await resolvePlanningPoiAutoSelection({
    localProductId: "poi-auto",
    keyword: "日喀则非物质文化遗产中心",
    product: { itinerary: [] },
    detail: { httpStatus: 200, businessStatus: "Success", poiListCount: 13, best: null, candidates },
    disambiguate: async ({ candidates: choices }) => {
      events.push(`ai:${choices.length}`);
      assert.equal(choices.some((choice) => choice.text.includes("候选13")), false);
      return { pickedText: choices[2]!.text, confidence: 0.95 };
    },
    checkAvailability: async (poiId) => {
      events.push(`availability:${poiId}`);
      return { status: "available" };
    },
  });

  assert.deepEqual(events, ["ai:12", "availability:1002"]);
  assert.deepEqual(result, {
    status: "available",
    match: { poiName: "候选3", poiId: 1002, province: "西藏", city: "日喀则" },
  });
});

test("AI 选中的暂停营业或低置信度候选不会返回给本地行程写入", async () => {
  const detail = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 1,
    best: null,
    candidates: [{ index: 1, poiName: "非物质文化遗产展示中心", poiId: 150237367, selectable: true, textFields: [] }],
  };
  const base = {
    localProductId: "poi-auto", keyword: "日喀则非物质文化遗产中心", product: {}, detail,
    disambiguate: async ({ candidates }: { candidates: Array<{ text: string }> }) => ({ pickedText: candidates[0]!.text, confidence: 0.95 }),
  };
  assert.deepEqual(await resolvePlanningPoiAutoSelection({ ...base, checkAvailability: async () => ({ status: "suspended" as const }) }), { status: "suspended" });
  assert.deepEqual(await resolvePlanningPoiAutoSelection({
    ...base,
    disambiguate: async ({ candidates }) => ({ pickedText: candidates[0]!.text, confidence: 0.8 }),
    checkAvailability: async () => ({ status: "available" as const }),
  }), { status: "uncertain" });
});

test("目的地为日喀则时，外地同名候选即使是精确首选也不能自动绑定", async () => {
  let availabilityCalls = 0;
  const result = await resolvePlanningPoiAutoSelection({
    localProductId: "poi-auto-location",
    keyword: "日喀则非物质文化遗产中心",
    product: { basicInfo: { destinationCity: "日喀则", province: "西藏" } },
    context: { destinationCity: "日喀则", province: "西藏" },
    detail: {
      httpStatus: 200,
      businessStatus: "Success",
      poiListCount: 1,
      best: { poiName: "非物质文化遗产展示中心", poiId: 150237367 },
      candidates: [{
        index: 1,
        poiName: "非物质文化遗产展示中心",
        poiId: 150237367,
        province: "河北",
        city: "石家庄",
        selectable: true,
        textFields: [],
      }],
    },
    checkAvailability: async () => {
      availabilityCalls += 1;
      return { status: "available" as const };
    },
  });

  assert.deepEqual(result, { status: "uncertain" });
  assert.equal(availabilityCalls, 0, "外地候选不得进入营业状态检查或写入路径");
});

test("城市锚点保持潮州时，明确写入南澳或汕头的行程可绑定同省跨城 POI", async () => {
  const product = {
    basicInfo: { meetingCity: "潮州", destinationCity: "潮州", province: "广东" },
    itinerary: [
      { day: 2, description: "经南澳大桥跨海登岛", spots: [{ name: "南澳大桥" }] },
      { day: 3, description: "汕头老城文化体验", spots: [{ name: "小公园" }] },
    ],
  };
  const resolve = (keyword: string, poiName: string, poiId: number, district?: string) => resolvePlanningPoiAutoSelection({
    localProductId: "poi-auto-cross-city",
    keyword,
    product,
    context: { destinationCity: "潮州", province: "广东" },
    detail: {
      httpStatus: 200, businessStatus: "Success", poiListCount: 1,
      best: { poiName, poiId },
      candidates: [{ index: 1, poiName, poiId, province: "广东", city: "汕头", ...(district ? { district } : {}), selectable: true, textFields: [] }],
    },
    checkAvailability: async () => ({ status: "available" as const }),
  });

  assert.equal((await resolve("南澳大桥", "南澳大桥", 10546075, "南澳县")).status, "available");
  assert.equal((await resolve("汕头小公园", "汕头小公园", 18400436)).status, "available");
  assert.deepEqual(product.basicInfo, { meetingCity: "潮州", destinationCity: "潮州", province: "广东" });
});

test("同名北回归线候选跨省时，即使用户安排该景点也不能自动绑定", async () => {
  const result = await resolvePlanningPoiAutoSelection({
    localProductId: "poi-auto-province",
    keyword: "北回归线广场",
    product: { itinerary: [{ day: 2, description: "南澳北回归线广场", spots: [{ name: "北回归线广场" }] }] },
    context: { destinationCity: "潮州", province: "广东" },
    detail: {
      httpStatus: 200, businessStatus: "Success", poiListCount: 1,
      best: { poiName: "北回归线标志塔", poiId: 143752967 },
      candidates: [{ index: 1, poiName: "北回归线标志塔", poiId: 143752967, province: "广西", city: "南宁", selectable: true, textFields: [] }],
    },
    checkAvailability: async () => ({ status: "available" as const }),
  });

  assert.deepEqual(result, { status: "uncertain" });
});

test("别名查询候选按原行程景点所在日核验地域", () => {
  const product = {
    itinerary: [{
      day: 2,
      description: "南澳岛环岛游，前往孤独榕树村观景。",
      spots: [{ name: "孤独榕树村", description: "南澳岛走马埔村海岸观景点" }],
    }],
  };
  assert.equal(isPlanningPoiCandidateInContext({
    index: 1, poiName: "南澳岛·孤独的树", poiId: 148709633, province: "广东", city: "汕头", district: "南澳县", selectable: true, textFields: [],
  }, { destinationCity: "潮州", province: "广东" }, product, "孤独榕树村"), true);
  assert.equal(isPlanningPoiCandidateInContext({
    index: 1, poiName: "孤独的树", poiId: 152873274, province: "浙江", city: "绍兴", district: "嵊州", selectable: true, textFields: [],
  }, { destinationCity: "潮州", province: "广东" }, product, "孤独榕树村"), false);
});

test("目的地已锁定时，缺少候选城市或仅由旧 POI、酒店字段暗示外地都不能自动绑定", async () => {
  let availabilityCalls = 0;
  const base = {
    localProductId: "poi-auto-missing-city",
    keyword: "小公园",
    context: { destinationCity: "潮州", province: "广东" },
    checkAvailability: async () => {
      availabilityCalls += 1;
      return { status: "available" as const };
    },
  };
  const missingCity = await resolvePlanningPoiAutoSelection({
    ...base,
    product: { itinerary: [{ day: 3, spots: [{ name: "小公园" }] }] },
    detail: {
      httpStatus: 200, businessStatus: "Success", poiListCount: 1,
      best: { poiName: "小公园", poiId: 1 },
      candidates: [{ index: 1, poiName: "小公园", poiId: 1, province: "广东", selectable: true, textFields: [] }],
    },
  });
  const pollutedEvidence = await resolvePlanningPoiAutoSelection({
    ...base,
    product: {
      itinerary: [{
        day: 3,
        hotel: "中山酒店",
        spots: [{ name: "小公园", poiName: "中山公园", description: "老城漫步" }],
      }],
    },
    detail: {
      httpStatus: 200, businessStatus: "Success", poiListCount: 1,
      best: { poiName: "小公园", poiId: 2 },
      candidates: [{ index: 1, poiName: "小公园", poiId: 2, province: "广东", city: "中山", selectable: true, textFields: [] }],
    },
  });

  assert.deepEqual(missingCity, { status: "uncertain" });
  assert.deepEqual(pollutedEvidence, { status: "uncertain" });
  assert.equal(availabilityCalls, 0);
});

test("省份已锁定时，候选缺少省份也不能通过别名绑定", () => {
  const product = { itinerary: [{ day: 2, description: "南澳岛观景", spots: [{ name: "孤独榕树村" }] }] };
  assert.equal(isPlanningPoiCandidateInContext({
    index: 1, poiName: "南澳岛·孤独的树", poiId: 148709633, city: "汕头", district: "南澳县", selectable: true, textFields: [],
  }, { destinationCity: "潮州", province: "广东" }, product, "孤独榕树村"), false);
});
