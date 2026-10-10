import test from "node:test";
import assert from "node:assert/strict";
import { resolveItineraryHotelCandidates, selectCtripHotelContext } from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { hotelFallbackAllowed, hotelDowngradePermission } from "../../src/shared/hotel-downgrade-policy.js";
import { hotelAnswerInstruction } from "../../src/main/agent/hotel-answer-instruction.js";
import { hotelStayRequirement, hotelDiamondForStay } from "../../src/shared/hotel-stay-requirement.js";
import { reusableHotelCandidates } from "../../src/main/infrastructure/ctrip-hotel-candidate-cache.js";
import { normaliseItinerary } from "../../src/main/data/product-normalize.js";
import { createItineraryHotelTool } from "../../src/main/agent/integration-itinerary-hotel-tool.js";
import { productSchema } from "../../src/main/automation/schema/schema-definitions.js";
import { extraPreparationGaps } from "../../src/main/planning/preparation-checks.js";
import { applyPersistedHotelTierChoices } from "../../src/main/agent/integration-patch.js";
import type { AgentEvent } from "../../src/shared/contracts.js";
const html = (hotelList: unknown[]) => `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initListData: { hotelList } })])})</script>`;
const municipal = { id: "1", cityId: 7589, cityName: "海西", word: "大柴旦镇人民政府", type: "Markland", gLat: 37.855, gLon: 95.355 };
const row = (diamond: number, lat = 37.855, lon = 95.355, cityId = 7589, cityName = "海西") => ({ hotelInfo: {
  summary: { hotelId: 1001 }, nameInfo: { name: "当地真实酒店" }, hotelStar: { star: diamond, starType: 0 }, commentInfo: { commentScore: 4.5 },
  positionInfo: { cityId, cityName, mapCoordinate: [{ latitude: lat, longitude: lon }] },
} });

test("默认逐级降档，用户全局许可、单日回答和最新拒绝优先", () => {
  assert.equal(hotelFallbackAllowed("", 2), true);
  assert.equal(hotelFallbackAllowed("", 2, false), false);
  assert.equal(hotelDowngradePermission("搜到哪个钻级能用就用哪个"), true);
  assert.equal(hotelDowngradePermission("酒店最差从5钻到无钻"), true);
  const instruction = '允许降档\n{"hotel2":"不要降档"}\n{"hotel3":"可以降低档次"}';
  assert.equal(hotelFallbackAllowed(instruction, 2), false);
  assert.equal(hotelFallbackAllowed(instruction, 3), true);
  assert.equal(hotelFallbackAllowed(instruction + '\n{"hotel3":"保留5钻酒店"}', 3), false);
});

test("文本住宿回答通过原问题映射为逐日指令", () => {
  const events = [{ type: "input_request", data: { request: { id: "r", questions: [{ id: "lodging", label: "第 2 天住宿", kind: "text" }] } } },
    { type: "user", content: "", data: { requestId: "r", resolvedAnswers: { lodging: "不要降档" } } }] as unknown as AgentEvent[];
  assert.equal(hotelFallbackAllowed(hotelAnswerInstruction(events), 2), false);
  assert.equal(hotelFallbackAllowed(hotelAnswerInstruction(events), 3), true);
});

test("官方镇政府定位父级城市且保留5km边界，不接受别的明确城市", () => {
  const context = selectCtripHotelContext([municipal], { anchorName: "大柴旦", preferredCity: "大柴旦", requirePreferredCity: true });
  assert.equal(context.cityName, "海西");
  assert.equal(context.name, municipal.word);
  assert.equal(context.requirement?.maxDistanceKm, 5);
  assert.throws(() => selectCtripHotelContext([municipal], { anchorName: "大柴旦", preferredCity: "西宁", requirePreferredCity: true }), /未找到/);
});

test("真实无钻候选经过检索、保存、要求解析与复用后仍有效", async () => {
  const original = globalThis.fetch; const grades: number[] = [];
  globalThis.fetch = async input => {
    if (String(input).includes("gaHotelSearchEngine")) return Response.json({ Response: { searchResults: [municipal] } });
    const grade = Number(new URL(String(input)).searchParams.get("listFilters")?.match(/16~(\d)/)?.[1] ?? 0);
    grades.push(grade); return new Response(html(grade === 0 ? [row(0)] : []));
  };
  try {
    const result = await resolveItineraryHotelCandidates([{ day: 2, hotel: "大柴旦当地酒店" }], "西宁", 5, "当地5钻酒店", undefined, undefined, true);
    assert.deepEqual(grades, [5, 4, 3, 2, 1, 0]);
    const [day] = normaliseItinerary(result.itinerary)!;
    const requirement = hotelStayRequirement({ basicInfo: {} }, day)!;
    assert.equal(requirement.diamond, 0);
    assert.ok(productSchema.shape.itinerary.safeParse([day]).success);
    assert.ok(!extraPreparationGaps({ basicInfo: { nights: 1 }, operations: { hotelTier: "当地5钻酒店" }, itinerary: [day] }).some(gap => gap.node === "hotelResolution"));
    assert.equal(hotelDiamondForStay("当地5钻酒店", requirement), 0);
    assert.equal(reusableHotelCandidates(day, "当地5钻酒店", requirement)?.[0].diamond, 0);
  } finally { globalThis.fetch = original; }
});

test("明确俄博梁或冷湖可自动尝试冷湖，剔除同城市远处酒店", async () => {
  const original = globalThis.fetch; const keywords: string[] = [];
  const cold = { ...municipal, cityId: 696158, cityName: "茫崖", word: "冷湖镇人民政府", gLat: 38.733, gLon: 93.335 };
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("gaHotelSearchEngine")) {
      const keyword = JSON.parse(String(init?.body)).keyword; keywords.push(keyword);
      return Response.json({ Response: { searchResults: keyword === "俄博梁" ? [{ ...cold, word: "俄博梁", gLat: 38.708, gLon: 92.706 }] : [cold] } });
    }
    return new Response(html([row(4, 38.733, 93.335, 696158, "茫崖"), { hotelInfo: { ...row(4, 37.855, 95.355, 696158, "茫崖").hotelInfo, summary: { hotelId: 999 } } }]));
  };
  try {
    const result = await resolveItineraryHotelCandidates([{ day: 3, hotel: "俄博梁或冷湖区域酒店入住。" }], "西宁", 5, "当地5钻酒店", undefined, undefined, true);
    assert.deepEqual(keywords, ["俄博梁", "冷湖"]);
    assert.equal(result.dailyCandidates[0]!.candidates.length, 1);
    assert.equal(result.itinerary[0]!.hotelRequirement && (result.itinerary[0]!.hotelRequirement as any).maxDistanceKm, 5);
    assert.equal(result.dailyCandidates[0]!.candidates[0]!.anchorName, "冷湖镇人民政府");
  } finally { globalThis.fetch = original; }
});


test("无用户回答时真实酒店工具使用默认降档并持久化，不要求逐档确认", async () => {
  let current: any = { id: "local", status: "planning", product: { basicInfo: { destinationCity: "西宁", nights: 1 },
    operations: { hotelTier: "当地5钻酒店" }, itinerary: [{ day: 1, hotel: "大柴旦当地酒店" }] } };
  const deps: any = { db: { listProducts: () => [], getAgentSnapshot: () => ({ events: [] }) },
    productMutations: { replace: (_id: string, product: unknown) => (current = { ...current, product }) } };
  const original = globalThis.fetch;
  globalThis.fetch = async input => String(input).includes("gaHotelSearchEngine")
    ? Response.json({ Response: { searchResults: [municipal] } })
    : new Response(html([row(3)]));
  try {
    const receipt = await createItineraryHotelTool(deps, () => current).execute({}, { localProductId: "local" } as any);
    assert.equal(JSON.parse(receipt.content).persisted, true);
    assert.equal(current.product.itinerary[0].hotelRequirement.diamond, 3);
    assert.equal(current.product.itinerary[0].hotelCandidates[0].hotelId, 1001);
  } finally { globalThis.fetch = original; }
});

test("用户明确选择无钻酒店时承接该回答，不继承旧5钻", () => {
  const product: any = { itinerary: [{ day: 2, hotel: "当地酒店", hotelRequirement: { anchorName: "大柴旦", diamond: 5, ratingType: "diamond" } }] };
  assert.equal((applyPersistedHotelTierChoices(product, '{"hotel2":"接受无钻酒店"}') as any).itinerary[0].hotelRequirement.diamond, 0);
});
