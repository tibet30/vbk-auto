import assert from "node:assert/strict";
import test from "node:test";
import { resolveRouteLocations } from "../../src/main/planning/route-location-resolution.js";
import { exactRouteAdministrativeDistrict } from "../../src/main/planning/numbered-route-administrative.js";
import { routeLocationsForSpot, verifiedRouteOvernightCity } from "../../src/shared/route-location-evidence.js";

type Json = Record<string, any>;

/** 真实样本：成都 4 天 3 晚私家团（`37feb911`），平台响应按 suggestDistrict 实测结构裁剪。 */
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
  九寨沟: { districts: [{ districtId: 25, districtName: "九寨沟", districtType: "City", parents: [aba, sichuan] }] },
};

function product(): Json {
  return {
    basicInfo: { province: "四川", meetingCity: "成都", destinationCity: "成都", userIdea: ROUTE },
    itinerary: [
      { day: 1, spots: [{ name: "毕棚沟", kind: "attraction", poiId: null, poiName: null }] },
      { day: 2, spots: [{ name: "达古冰川", kind: "attraction", poiId: 87386, poiName: "达古冰川风景名胜区" }] },
      { day: 3, spots: [{ name: "黄龙景区", kind: "attraction", poiId: null, poiName: null }] },
      { day: 4, spots: [] },
    ],
    diagnostics: {} as Json,
  };
}

async function resolved(): Promise<Json> {
  const value = product();
  const queried: string[] = [];
  value.diagnostics.routeLocations = await resolveRouteLocations(value, async (name: string) => {
    queried.push(name);
    return payloads[name] ? exactRouteAdministrativeDistrict(payloads[name], name, undefined, { allowTown: true }) : undefined;
  });
  value.queried = queried;
  return value;
}

test("「住：黑水」去掉前缀和冒号后按「黑水」查询，第 1 天补上黑水锚点", async () => {
  const value = await resolved();
  assert.ok(!value.queried.some((name: string) => /^[:：]/u.test(name)), `误查：${value.queried.join("|")}`);
  const day1 = (value.diagnostics.routeLocations as Json[]).filter(node => node.day === 1).map(node => node.name);
  assert.deepEqual(day1, ["成都", "黑水"]);
  assert.deepEqual(routeLocationsForSpot(value, value.itinerary[0], "毕棚沟").map(item => item.city), ["成都", "阿坝"]);
});

test("唯一乡镇「川主寺镇」作路线锚点：城市取州、区县取县，黄龙景区有了阿坝锚点", async () => {
  const value = await resolved();
  const day3 = (value.diagnostics.routeLocations as Json[]).find(node => node.day === 3 && node.name === "川主寺");
  assert.equal(day3?.city, "阿坝");
  assert.equal(day3?.district, "松潘");
  assert.equal(day3?.town, true);
  assert.deepEqual(routeLocationsForSpot(value, value.itinerary[2], "黄龙景区").map(item => item.city), ["阿坝"]);
});

test("乡镇锚点不作为住宿行政城市：第 2 天住川主寺不会被推断成写入城市", async () => {
  const value = await resolved();
  assert.equal(verifiedRouteOvernightCity(value, value.itinerary[1]), undefined);
  assert.equal(verifiedRouteOvernightCity(value, value.itinerary[0]), "黑水");
});

test("乡镇只在显式允许时接受，且必须唯一、同名、在锁定省份内", () => {
  const town = payloads.川主寺!;
  assert.equal(exactRouteAdministrativeDistrict(town, "川主寺"), undefined, "景点转交通节点不接受乡镇");
  assert.equal(exactRouteAdministrativeDistrict(town, "川主寺", "四川", { allowTown: true })?.districtId, 2087478);
  assert.equal(exactRouteAdministrativeDistrict(town, "川主寺镇", undefined, { allowTown: true })?.districtId, 2087478);
  assert.equal(exactRouteAdministrativeDistrict(town, "川主寺", "甘肃", { allowTown: true }), undefined);
  assert.equal(exactRouteAdministrativeDistrict({ districts: [...town.districts, { ...town.districts[0], districtId: 9 }] },
    "川主寺", undefined, { allowTown: true }), undefined, "同名乡镇不唯一");
  assert.equal(exactRouteAdministrativeDistrict(town, "主寺", undefined, { allowTown: true }), undefined);
});
