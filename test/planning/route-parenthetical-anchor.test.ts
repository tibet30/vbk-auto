import assert from "node:assert/strict";
import test from "node:test";
import { resolveRouteLocations } from "../../src/main/planning/route-location-resolution.js";
import { routeLocationBlockers, routeLocationsForSpot } from "../../src/shared/route-location-evidence.js";

type Json = Record<string, any>;

/** 真实样本：长沙 2 天 1 晚自由行（`78becba3`），括号内的顿号曾把行政锚点切坏。 */
const ROUTE = `D1：抵达黄花机场 → 韶山（毛泽东故居、铜像广场、韶峰），车程约 1h；宿韶山
D2：韶山 → 长沙市区（橘子洲、岳麓山）→ 送黄花机场`;

const districts: Record<string, Json> = {
  韶山: { districtId: 346, districtName: "韶山", districtType: "City", parents: [
    { districtName: "湘潭", districtType: "City" }, { districtName: "湖南", districtType: "Province" }] },
  长沙: { districtId: 206, districtName: "长沙", districtType: "City", parents: [
    { districtName: "湖南", districtType: "Province" }] },
};

const bound = (name: string, poiName: string, poiId: number, city: string, district: string): Json =>
  ({ name, kind: "attraction", poiName, poiId, province: "湖南", city, district });

function product(): Json {
  return {
    basicInfo: { province: "湖南", meetingCity: "长沙", destinationCity: "长沙", destination: "长沙", userIdea: ROUTE },
    itinerary: [
      { day: 1, title: "韶山", spots: [
        bound("毛泽东故居", "毛泽东同志故居", 79888, "湘潭", "韶山"),
        bound("铜像广场", "铜像广场", 148639702, "湘潭", "湘潭县"),
        bound("韶峰", "韶峰", 69342837, "湘潭", "韶山")] },
      { day: 2, title: "韶山 · 橘子洲 · 岳麓山", spots: [
        bound("橘子洲", "橘子洲景区", 77604, "长沙", "长沙"),
        bound("岳麓山", "岳麓山", 77605, "长沙", "长沙")] },
    ],
    diagnostics: {} as Json,
  };
}

async function resolved(): Promise<Json> {
  const value = product();
  const queried: string[] = [];
  value.diagnostics.routeLocations = await resolveRouteLocations(value, async (name: string) => {
    queried.push(name);
    return districts[name];
  });
  value.queried = queried;
  return value;
}

test("括号里的顿号不切坏行政锚点：韶山（景点、景点）与长沙市区（景点、景点）都能解析", async () => {
  const value = await resolved();
  const anchors = (value.diagnostics.routeLocations as Json[]).map((node) => [node.day, node.name, node.city]);
  assert.deepEqual(anchors, [[1, "韶山", "湘潭"], [2, "韶山", "湘潭"], [2, "长沙", "长沙"]]);
});

test("「长沙市区」按城市「长沙」解析，括号内的景点不会被当成行政地名去查", async () => {
  const value = await resolved();
  assert.ok(!value.queried.some((name: string) => /[（）、]|毛泽东故居|橘子洲/.test(name)), `误查：${value.queried.join("|")}`);
  assert.ok(value.queried.includes("长沙"));
});

test("橘子洲(长沙)取到长沙锚点，已绑定 POI 的地域校验通过，不再留待处理项", async () => {
  const value = await resolved();
  assert.deepEqual(routeLocationsForSpot(value, value.itinerary[1], "橘子洲"),
    [{ province: "湖南", city: "长沙", bounded: false }]);
  assert.deepEqual(routeLocationBlockers(value), []);
});

test("真跨城的错绑仍被拦住：把橘子洲绑到湘潭时仍报地域缺证据", async () => {
  const value = await resolved();
  value.itinerary[1].spots[0] = bound("橘子洲", "橘子洲景区", 77604, "湘潭", "韶山");
  assert.match(routeLocationBlockers(value)[0]?.label ?? "", /第2天景点地域：橘子洲/);
});
