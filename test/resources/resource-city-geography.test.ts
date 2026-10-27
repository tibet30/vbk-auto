import test from "node:test";
import assert from "node:assert/strict";
import { resolveResourceSegmentCityApi } from "../../src/main/automation/ctrip/vehicle-resource-api/segment-apis.js";

test("住宿段把万州按平台可写城市重庆查询，且不查询平台不存在的万州", async () => {
  const keywords: string[] = [];
  const page = { nativeOnly: true, vbkSessionFetch: async (input: any) => {
    assert.equal(new URL(input.endpoint).pathname, "/restapi/soa2/15638/suggestDepartureCity");
    keywords.push(input.body.keyword);
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" },
      cities: input.body.keyword === "重庆"
        ? [{ cityId: 4, cityName: "重庆", countryName: "中国", provinceName: "重庆" }] : [] } };
  } };
  const selected = await resolveResourceSegmentCityApi(page, "万州", { countryName: "中国", province: "重庆" });
  assert.deepEqual(keywords, ["重庆"]);
  assert.deepEqual(selected, { cityId: 4, cityName: "重庆", countryName: "中国", provinceName: "重庆" });
});

test("住宿段只读城市查询沿用已知国家，排除越南同名广安且不调用保存接口", async () => {
  const calls: string[] = [];
  const cities = [
    { cityId: 807649, cityName: "广安", countryName: "越南", provinceName: "清化省" },
    { cityId: 697166, cityName: "广安", countryName: "越南", provinceName: "广宁省" },
    { cityId: 1100, cityName: "广安", countryName: "中国", provinceName: "四川" },
  ];
  const page = { nativeOnly: true, vbkSessionFetch: async (input: any) => {
    calls.push(input.endpoint);
    assert.equal(new URL(input.endpoint).pathname, "/restapi/soa2/15638/suggestDepartureCity");
    assert.equal(input.body.keyword, "广安");
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, cities } };
  } };
  const selected = await resolveResourceSegmentCityApi(page, "广安", { countryName: "中国" });
  assert.equal(selected.cityId, 1100);
  assert.equal(calls.length, 1);
  await assert.rejects(resolveResourceSegmentCityApi(page, "广安"), /3 个规范候选.*3≠1/);
  cities.pop();
  await assert.rejects(resolveResourceSegmentCityApi(page, "广安", { countryName: "中国" }), /筛选后0个.*0≠1/);
});
