import assert from "node:assert/strict";
import test from "node:test";
import { spotNamedHotelCity, unwritableHotelCityReason } from "../../src/shared/hotel-city-evidence.js";

const product = { basicInfo: { province: "西藏" } };
const bound = (name: string, poiId: number, city: string, district: string | undefined, province = "西藏") =>
  ({ name, poiName: name, poiId, province, city, ...(district ? { district } : {}) });

test("住宿地写的是当天已核验景点名时，返回该景点的所属县市", () => {
  const day = { day: 2, spots: [
    bound("扎什伦布寺", 76348, "日喀则", "日喀则"),
    bound("珠峰绒布冰川遗迹", 76353, "日喀则", "定日"),
  ] };
  assert.deepEqual(spotNamedHotelCity(product, day, ["珠峰"]), { city: "定日", spotName: "珠峰绒布冰川遗迹" });
});

test("住宿地本身是景点所属的市或县时不产生证据，避免把地级市改写成下辖区", () => {
  const day = { day: 1, spots: [bound("日喀则博物馆", 1, "日喀则", "桑珠孜")] };
  assert.equal(spotNamedHotelCity(product, day, ["日喀则"]), undefined);
  const county = { day: 2, spots: [bound("珠峰绒布冰川遗迹", 76353, "日喀则", "定日")] };
  assert.equal(spotNamedHotelCity(product, county, ["定日"]), undefined);
});

test("景点没有真实 poiId、跨省或没有行政归属时都不算证据", () => {
  const unbound = { day: 2, spots: [{ name: "珠峰绒布冰川遗迹" }] };
  assert.equal(spotNamedHotelCity(product, unbound, ["珠峰"]), undefined);
  const otherProvince = { day: 2, spots: [bound("珠峰绒布冰川遗迹", 76353, "日喀则", "定日", "青海")] };
  assert.equal(spotNamedHotelCity(product, otherProvince, ["珠峰"]), undefined);
  const noAdmin = { day: 2, spots: [bound("珠峰绒布冰川遗迹", 76353, "", undefined)] };
  assert.equal(spotNamedHotelCity(product, noAdmin, ["珠峰"]), undefined);
});

test("乡镇、村级与景区后缀的住宿城市可判定为不可写", () => {
  assert.match(unwritableHotelCityReason("狮泉河镇") ?? "", /乡镇或景区名/u);
  assert.match(unwritableHotelCityReason("毕棚沟景区") ?? "", /乡镇或景区名/u);
  assert.equal(unwritableHotelCityReason("珠峰"), undefined);
  assert.equal(unwritableHotelCityReason("定日"), undefined);
});
