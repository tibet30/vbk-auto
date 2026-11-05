import assert from "node:assert/strict";
import test from "node:test";
import { resolveRouteLocations } from "../../src/main/planning/route-location-resolution.js";
import { exactRouteAdministrativeDistrict } from "../../src/main/planning/numbered-route-administrative.js";
import { resolvePlanningPoiAutoSelection, type PoiAutoDisambiguator } from "../../src/main/planning/poi-auto-selection.js";
import { hasDefinitePoiLocationConflict } from "../../src/main/planning/poi-location-conflict.js";
import { routeLocationBlockers } from "../../src/shared/route-location-evidence.js";
import { mergePoiAdjudications } from "../../src/shared/poi-adjudication-receipt.js";
import { splitProduct } from "../../src/shared/product-storage-projection.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Json = Record<string, any>;

/**
 * 真实样本：成都 4 天 3 晚私家团（`37feb911`）。为了模拟「规则判不了」，
 * 去掉第 1 天的黑水锚点（修复前的冒号漏解析状态），第 1 天只剩成都锚点。
 */
const ROUTE = `Day1：成都-毕棚沟-毕棚沟住宿-住：黑水
Day2：黑水-达古冰川-住：川主寺
Day3：川主寺-黄龙景区-住：九寨沟沟口
Day4：九寨沟-成都`;
const sichuan = { districtName: "四川", districtType: "Province" };
const aba = { districtName: "阿坝藏族羌族自治州", districtType: "City" };
const payloads: Record<string, Json> = {
  成都: { districts: [{ districtId: 104, districtName: "成都", districtType: "City", parents: [sichuan] }] },
  黑水: { districts: [{ districtId: 120552, districtName: "黑水", districtType: "City", parents: [aba, sichuan] }] },
  川主寺: { districts: [{ districtId: 2087478, districtName: "川主寺镇", districtType: "Town",
    parents: [{ districtName: "松潘", districtType: "City" }, aba, sichuan] }] },
};
const bipenggou = { index: 1, poiName: "毕棚沟", poiId: 89964, province: "四川", city: "阿坝", district: "理县",
  selectable: true, textFields: [], latitude: 31.3194, longitude: 102.9552 };
const wrongCity = { index: 2, poiName: "毕棚沟农家乐", poiId: 70001, province: "四川", city: "成都", district: "崇州",
  selectable: true, textFields: [], latitude: 30.63, longitude: 103.67 };
const otherProvince = { index: 3, poiName: "毕棚沟", poiId: 70002, province: "甘肃", city: "陇南",
  selectable: true, textFields: [], latitude: 33.4, longitude: 104.9 };
const farAway = { ...bipenggou, poiId: 70003, city: "凉山", district: "西昌", latitude: 27.88, longitude: 102.27 };

async function product(options: { keepHeishui?: boolean } = {}): Promise<Json> {
  const value: Json = {
    basicInfo: { province: "四川", meetingCity: "成都", destinationCity: "成都", userIdea: ROUTE },
    itinerary: [
      { day: 1, spots: [{ name: "毕棚沟", kind: "attraction", poiId: null, poiName: null }] },
      { day: 2, spots: [{ name: "达古冰川", kind: "attraction", poiId: 87386, poiName: "达古冰川风景名胜区",
        province: "四川", city: "阿坝", latitude: 32.2034, longitude: 102.8817 }] },
      { day: 3, spots: [{ name: "黄龙景区", kind: "attraction", poiId: null, poiName: null }] },
      { day: 4, spots: [] },
    ],
    diagnostics: {},
  };
  const nodes = await resolveRouteLocations(value, async (name: string) =>
    payloads[name] ? exactRouteAdministrativeDistrict(payloads[name], name, undefined, { allowTown: true }) : undefined);
  value.diagnostics.routeLocations = options.keepHeishui ? nodes
    : nodes.filter((node: Json) => !(node.day === 1 && node.name === "黑水"));
  return value;
}

function select(value: Json, candidates: Json[], disambiguate?: PoiAutoDisambiguator) {
  return resolvePlanningPoiAutoSelection({
    localProductId: "aba", keyword: "毕棚沟", product: value,
    context: { province: "四川", destinationCity: "成都", itineraryDay: 1, spotName: "毕棚沟" } as Json,
    detail: { httpStatus: 200, businessStatus: "Success", poiListCount: candidates.length, best: null, candidates: candidates as never },
    checkAvailability: async () => ({ status: "available" as const }),
    ...(disambiguate ? { disambiguate } : {}),
  });
}

const pick = (poiId: number, confidence: number): PoiAutoDisambiguator => async ({ candidates }) =>
  ({ pickedText: candidates.find(choice => choice.id === String(poiId))?.text ?? null, confidence, reasoning: "沿当天路线" });

test("规则未证实地域时，AI 看到同省候选、距离与当天原路线，并以 ≥0.9 置信度采纳", async () => {
  const value = await product();
  assert.equal((await select(value, [bipenggou])).status, "uncertain", "无 AI 时规则仍判不了");
  let seen: Json = {};
  const result = await select(value, [wrongCity, bipenggou, otherProvince], async (args) => {
    seen = args;
    return pick(89964, 0.95)(args);
  });
  assert.equal(result.status, "available");
  assert.equal(result.match?.poiId, 89964);
  assert.deepEqual(result.match?.adjudication, { confidence: 0.95, reasoning: "沿当天路线" });
  assert.deepEqual(seen.candidates.map((choice: Json) => choice.id), ["70001", "89964"], "外省候选不进候选池");
  assert.match(seen.candidates[1].text, /毕棚沟 · 四川\/阿坝\/理县 · 距当日已核验路线约 99 km · 规则地域：未证实 · POI 89964/u);
  assert.equal(seen.context.originalRoute.currentDay, "成都-毕棚沟-毕棚沟住宿-住：黑水");
  assert.deepEqual(seen.context.verifiedNearbyPois.map((poi: Json) => poi.name), ["达古冰川"]);
});

test("硬门：规则外候选置信度 <0.9、超出 160 km、AI 不选或报错都不采纳", async () => {
  const value = await product();
  assert.deepEqual(await select(value, [bipenggou], pick(89964, 0.85)), { status: "uncertain", reason: "ambiguous" });
  assert.equal((await select(value, [farAway], pick(70003, 0.99))).status, "uncertain");
  assert.equal((await select(value, [bipenggou], async () => ({ pickedText: null, confidence: 0 }))).status, "uncertain");
  const failed = await select(value, [bipenggou], async () => { throw new Error("AI 超时"); });
  assert.equal(failed.status, "uncertain", "AI 出错按不确定处理，不变成查询失败");
});

test("同名多候选不再直接要求人工：有 AI 时交给 AI 裁决，没有 AI 时仍为 ambiguous", async () => {
  // 保留黑水锚点：两条阿坝「毕棚沟」都通过规则地域，身份只能裁决。
  const value = await product({ keepHeishui: true });
  const twin = { ...bipenggou, poiId: 70004, district: "汶川", latitude: 31.48, longitude: 103.59 };
  const candidates = [bipenggou, twin];
  assert.deepEqual(await select(value, candidates), { status: "uncertain", reason: "ambiguous" });
  assert.deepEqual(await select(value, candidates, pick(89964, 0.85)), { status: "uncertain", reason: "ambiguous" },
    "同名裁决按规则外阈值 0.9");
  const result = await select(value, candidates, pick(89964, 0.92));
  assert.equal(result.match?.poiId, 89964);
  assert.equal(result.match?.adjudication?.confidence, 0.92);
});

test("裁决凭证：就绪检查与复核认可当前原路线下的凭证；改了原路线即失效", async () => {
  const value = await product();
  Object.assign(value.itinerary[0].spots[0], { poiId: 89964, poiName: "毕棚沟", province: "四川", city: "阿坝",
    district: "理县", latitude: 31.3194, longitude: 102.9552 });
  const label = "第1天景点地域：毕棚沟";
  assert.ok(routeLocationBlockers(value).some(issue => issue.label === label), "无凭证时规则报地域问题");
  const context = { province: "四川", destinationCity: "成都", itineraryDay: 1, spotName: "毕棚沟" };

  value.diagnostics.poiAdjudications = mergePoiAdjudications(value, [{ day: 1, spotName: "毕棚沟", poiName: "毕棚沟",
    poiId: 89964, province: "四川", city: "阿坝", adjudication: { confidence: 0.95, reasoning: "沿当天路线" } }], "2026-11-05T00:00:00Z");
  assert.equal(routeLocationBlockers(value).some(issue => issue.label === label), false);
  assert.equal(hasDefinitePoiLocationConflict(bipenggou as never, context, value, "毕棚沟"), false);

  const reused = await select(value, [wrongCity, bipenggou], async () => { throw new Error("不应再调用 AI"); });
  assert.equal(reused.match?.poiId, 89964, "有效凭证直接沿用");

  const { evidence } = splitProduct(value);
  assert.ok(evidence.fields.some(field => field.path.join(".") === "diagnostics.poiAdjudications"), "凭证随资源证据保存");

  const edited = structuredClone(value);
  edited.basicInfo.userIdea = ROUTE.replace("住：黑水", "住：理县");
  assert.ok(routeLocationBlockers(edited).some(issue => issue.label === label), "原路线变了，凭证失效");
  assert.deepEqual(mergePoiAdjudications(edited, [], "2026-11-05T01:00:00Z"), [], "失效凭证在下次写回时清理");

  const moved = structuredClone(value);
  moved.basicInfo.province = "甘肃";
  assert.equal(hasDefinitePoiLocationConflict(bipenggou as never, { ...context, province: "甘肃" }, moved, "毕棚沟"), true,
    "产品省份变了，凭证不再背书");
  const rebound = structuredClone(value);
  Object.assign(rebound.itinerary[0].spots[0], { poiId: 70001, poiName: "毕棚沟农家乐", city: "成都", district: "崇州" });
  assert.deepEqual(mergePoiAdjudications(rebound, [], "2026-11-05T01:00:00Z"), [], "改绑别的 POI 后凭证清理");
});

test("写回行程时裁决凭证与绑定同一次落库，并能从数据库读回", async () => {
  const route = "Day1：成都-毕棚沟-住：黑水";
  const db = new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-adjudication-")));
  const detail = db.createProduct({ destination: "成都", days: 1, productForm: "privateTour", userIdea: route });
  const itinerary = [{ day: 1, spots: [{ name: "毕棚沟", kind: "attraction", poiId: null, poiName: null }] }];
  const draft: Json = { ...detail.product, basicInfo: { ...detail.product.basicInfo, province: "四川", userIdea: route }, itinerary };
  // 只保留成都锚点：规则无法证明毕棚沟在阿坝，绑定只能靠 AI 裁决凭证。
  draft.diagnostics = { routeLocations: (await resolveRouteLocations(draft, async (name: string) =>
    payloads[name] ? exactRouteAdministrativeDistrict(payloads[name], name) : undefined))
    .filter((node: Json) => node.name === "成都") };
  db.updateProduct(detail.id, draft);
  const previous = db.getProduct(detail.id)!.product.itinerary!;
  const next = structuredClone(previous) as Json[];
  Object.assign(next[0]!.spots[0], { poiId: 89964, poiName: "毕棚沟", province: "四川", city: "阿坝", district: "理县" });
  const result = await new DbOrchestratorRuntime(db).writeResolvedItineraryPois(detail.id, next, previous, [{ day: 1,
    spotName: "毕棚沟", poiName: "毕棚沟", poiId: 89964, province: "四川", city: "阿坝", district: "理县",
    adjudication: { confidence: 0.95, reasoning: "沿当天路线" } }]);
  assert.equal(result.ok, true, result.reason);
  const saved = db.getProduct(detail.id)!.product as Json;
  assert.equal(saved.itinerary[0].spots[0].poiId, 89964);
  assert.deepEqual(saved.diagnostics.poiAdjudications.map((item: Json) => [item.day, item.spotName, item.poiId, item.confidence]),
    [[1, "毕棚沟", 89964, 0.95]]);
  assert.equal(saved.diagnostics.routeLocations.length, 1, "不覆盖行政锚点");
  assert.ok(routeLocationBlockers({ ...saved, diagnostics: { ...saved.diagnostics, poiAdjudications: [] } })
    .some(issue => issue.label === "第1天景点地域：毕棚沟"), "没有凭证时规则会报地域问题");
  assert.equal(routeLocationBlockers(saved).some(issue => issue.label === "第1天景点地域：毕棚沟"), false);
});
