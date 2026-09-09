import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlanningPoiAutoSelection } from "../../src/main/planning/poi-auto-selection.js";

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
