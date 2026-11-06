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

const aba = { districtId: 744, districtName: "阿坝藏族羌族自治州", districtType: "City" };
const sichuan = [{ districtId: 100009, districtName: "四川", districtType: "Province" },
  { districtId: 110000, districtName: "中国", districtType: "Country" }];
/** suggestDistrict 实测响应裁剪（2026-11-06）。 */
const DISTRICTS: Record<string, any[]> = {
  川主寺: [{ districtId: 2087478, districtName: "川主寺镇", districtType: "Town",
    parents: [{ districtId: 606, districtName: "松潘", districtType: "City" }, aba, ...sichuan] }],
  九寨沟: [{ districtId: 25, districtName: "九寨沟", districtType: "City", parents: [aba, ...sichuan] },
    { districtId: 2085043, districtName: "漳扎镇", districtType: "Town",
      parents: [{ districtId: 25, districtName: "九寨沟", districtType: "City" }, aba, ...sichuan] }],
  毕棚沟: [{ districtId: 2141901, districtName: "毕棚沟", districtType: "SightZone",
    parents: [{ districtId: 1445566, districtName: "理县", districtType: "City" }, aba, ...sichuan] }],
  黑水: [{ districtId: 120552, districtName: "黑水", districtType: "City", parents: [aba, ...sichuan] },
    { districtId: 2095936, districtName: "黑水镇", districtType: "Town", parents: [{ districtId: 2132, districtName: "建平", districtType: "City" },
      { districtId: 100061, districtName: "辽宁", districtType: "Province" }, { districtId: 110000, districtName: "中国", districtType: "Country" }] }],
};

/** VBK 查无结果时省略 cities 字段（实测「九寨沟沟口」「川主寺」），不是协议异常。 */
function cityPage(known: Record<string, any>, calls: string[] = [], districts = DISTRICTS) {
  return { nativeOnly: true, vbkSessionFetch: async (input: any) => {
    const action = new URL(input.endpoint).pathname.split("/").at(-1);
    calls.push(`${action}:${input.body.keyword}`);
    if (action === "suggestDistrict") {
      const list = districts[input.body.keyword];
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...(list ? { districts: list } : {}) } };
    }
    assert.equal(action, "suggestDepartureCity");
    const city = known[input.body.keyword];
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...(city ? { cities: [city] } : {}) } };
  } };
}
const sc = (cityId: number, cityName: string) => ({ cityId, cityName, countryName: "中国", provinceName: "四川" });
const KNOWN = { 松潘: sc(1372, "松潘"), 九寨沟: sc(91, "九寨沟"), 理县: sc(1446, "理县"), 黑水: sc(21928, "黑水") };

test("住宿城市查空时按行政父链取所属县：川主寺镇 → 松潘", async () => {
  const calls: string[] = [];
  const city = await resolveResourceSegmentCityApi(cityPage(KNOWN, calls), "川主寺", { countryName: "中国", province: "四川" });
  assert.equal(city.cityId, 1372);
  assert.deepEqual(calls, ["suggestDepartureCity:川主寺", "suggestDistrict:川主寺", "suggestDepartureCity:松潘"]);
});

test("景区门户「九寨沟沟口」还原为九寨沟县，景区「毕棚沟」取所属理县", async () => {
  const page = cityPage(KNOWN);
  assert.equal((await resolveResourceSegmentCityApi(page, "九寨沟沟口", { countryName: "中国", province: "四川" })).cityId, 91);
  assert.equal((await resolveResourceSegmentCityApi(page, "毕棚沟", { countryName: "中国" })).cityId, 1446);
});

test("平台城市表能直接命中时不查行政父级", async () => {
  const calls: string[] = [];
  await resolveResourceSegmentCityApi(cityPage(KNOWN, calls), "黑水", { countryName: "中国", province: "四川" });
  assert.deepEqual(calls, ["suggestDepartureCity:黑水"]);
});

test("行政父级必须在锁定省份内唯一，外省或多个同名节点都停止", async () => {
  await assert.rejects(resolveResourceSegmentCityApi(cityPage(KNOWN), "川主寺", { countryName: "中国", province: "甘肃" }),
    /行政区父级也无法唯一确认所属县市/);
  const duplicated = { ...DISTRICTS, 川主寺: [...DISTRICTS.川主寺!, { ...DISTRICTS.川主寺![0], districtId: 9 }] };
  await assert.rejects(resolveResourceSegmentCityApi(cityPage(KNOWN, [], duplicated), "川主寺", { countryName: "中国", province: "四川" }),
    /行政区父级也无法唯一确认所属县市/);
});

test("父级县市不在平台城市表时说明经由的行政节点", async () => {
  await assert.rejects(resolveResourceSegmentCityApi(cityPage({}), "川主寺", { countryName: "中国", province: "四川" }),
    /所属县市「松潘」（经川主寺镇）不在 VBK 城市列表中/);
});
