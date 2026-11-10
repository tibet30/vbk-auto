import assert from "node:assert/strict";
import test from "node:test";
import { itineraryStructureError } from "../../src/main/planning/itinerary-structure.js";
import { validateItinerary } from "../../src/main/planning/validation/validators-basic.js";
import { validateModuleValue } from "../../src/main/planning/schemas.js";
import { itineraryPoisAreComplete, detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import { hasValidItinerary } from "../../src/main/automation/automation-contract.helpers.js";
import { dayMayHaveNoSpots, productFormAllowsSpotlessDays } from "../../src/shared/itinerary-content.js";
import { executeStageOutput, sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

function day(dayNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    day: dayNumber,
    title: `第 ${dayNumber} 天自由活动`,
    description: "当日由游客自行安排活动，不含固定景点。",
    hotel: "无当日住宿安排",
    meals: "早餐含；正餐敬请自理。",
    spots: [],
    ...overrides,
  };
}

function product(productForm: string, itinerary: Array<Record<string, unknown>> = [day(1), day(2)]) {
  return { sales: { productForm }, basicInfo: { days: itinerary.length }, itinerary };
}

test("自由行整天不排景点是合法行程，结构回读不再要求 spots", () => {
  assert.equal(productFormAllowsSpotlessDays("freeTravel"), true);
  assert.equal(productFormAllowsSpotlessDays("privateTour"), false);
  assert.equal(dayMayHaveNoSpots(day(1), "freeTravel"), true);
  assert.equal(dayMayHaveNoSpots(day(1), "privateTour"), false);
  assert.equal(itineraryStructureError(product("freeTravel")), undefined);
});

test("非自由行产品仍要求无景点日有接送或独立活动安排", () => {
  const spotless = product("privateTour");
  assert.match(itineraryStructureError(spotless) ?? "", /第 1 天缺少 spots 或合法服务活动/);
  const rejected = validateItinerary({ product: spotless, expectedDays: 2, accepted: true });
  assert.equal(rejected?.status, "rejected");
  assert.match(rejected?.reason ?? "", /缺少已验证 spots 或用户其他活动/);
  assert.equal(itineraryPoisAreComplete(spotless.itinerary), false);
  assert.equal(hasValidItinerary(spotless), false);
  assert.deepEqual(detectAcceptedModulesFromProduct(spotless).includes("itinerary"), false);
});

test("自由行空行程日通过结构、深度校验、完整性判断与自动化契约", () => {
  const freeTravel = product("freeTravel");
  assert.equal(validateItinerary({ product: freeTravel, expectedDays: 2, accepted: true }), null);
  assert.equal(itineraryPoisAreComplete(freeTravel.itinerary, "freeTravel"), true);
  assert.equal(hasValidItinerary(freeTravel), true);
  assert.equal(detectAcceptedModulesFromProduct(freeTravel).includes("itinerary"), true);
});

test("行程模块 schema 不再把无景点日写死，产品级门禁单独判断", () => {
  const value = [day(1), day(2)];
  assert.equal(validateModuleValue("itinerary", value).ok, true);
});

test("行程模块写入：非自由行空日写前拦截，自由行放行", () => {
  const value = [day(1), day(2)];
  const blocked = sanitiseModuleValue("itinerary", value, 1, undefined, { productForm: "privateTour" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? "" : blocked.reason, /缺少 spots 或合法服务活动/);
  assert.equal(sanitiseModuleValue("itinerary", value, 1, undefined, { productForm: "freeTravel" }).ok, true);
});

test("自由行仍校验天标题、描述与餐食等必填字段", () => {
  const missingMeals = product("freeTravel", [day(1, { meals: "" }), day(2)]);
  assert.match(itineraryStructureError(missingMeals) ?? "", /缺少 meals/);
  const rejected = validateItinerary({ product: missingMeals, expectedDays: 2, accepted: true });
  assert.match(rejected?.reason ?? "", /meals 缺失/);
});

test("自由行已绑定的景点仍按 POI 完整性判断", () => {
  const bound = product("freeTravel", [day(1, {
    spots: [{ name: "宽窄巷子", kind: "attraction", poiName: "宽窄巷子", poiId: null }],
  }), day(2)]);
  assert.equal(itineraryPoisAreComplete(bound.itinerary, "freeTravel"), false);
  assert.equal(hasValidItinerary(bound), false);
});

test("各产品形态的空日判定一致：只有自由行放行", () => {
  for (const form of ["privateTour", "groupTour", "semiSelfGuided", undefined]) {
    const spotless = product(form as string);
    assert.match(itineraryStructureError(spotless) ?? "", /缺少 spots 或合法服务活动/, String(form));
    assert.equal(hasValidItinerary(spotless), false, String(form));
    assert.equal(validateItinerary({ product: spotless, expectedDays: 2, accepted: true })?.status, "rejected", String(form));
    assert.equal(sanitiseModuleValue("itinerary", [day(1), day(2)], 1, undefined, { productForm: form }).ok, false, String(form));
  }
});

test("非自由行空日但有接送安排仍然成立", () => {
  const transfer = day(1, { activities: [{ time: "09:00", title: "接站", detail: "机场接站送酒店", type: "transport" }] });
  assert.equal(itineraryStructureError(product("privateTour", [transfer])), undefined);
});

test("executeStageOutput 按当前产品形态拦截或放行空日", async () => {
  async function run(form: string | undefined) {
    const writes: unknown[] = [];
    const result = await executeStageOutput({
      stage: "itinerary",
      localProductId: "spotless",
      runtime: {
        async loadCurrentProduct() { return { sales: { productForm: form } }; },
        async writeModule(_id: string, _m: string, _p: string, value: unknown) { writes.push(value); return { ok: true as const }; },
      } as any,
      output: { reply: "行程", modules: [{ module: "itinerary", status: "accepted", value: [day(1)] }] },
    });
    return { result, writes };
  }
  const free = await run("freeTravel");
  assert.equal(free.result.rejected.length, 0);
  assert.equal(free.writes.length, 1);
  const privateTour = await run("privateTour");
  assert.equal(privateTour.writes.length, 0);
  assert.match(privateTour.result.rejected[0]?.reason ?? "", /缺少 spots 或合法服务活动/);
  assert.equal((await run(undefined)).writes.length, 0);
});
