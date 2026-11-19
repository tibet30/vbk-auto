import assert from "node:assert/strict";
import test from "node:test";
import { extraPreparationGaps } from "../../src/main/planning/preparation-checks.js";
import { PLATFORM_HOTEL_DESCRIPTION, defaultPlatformHotelRules } from "../../src/shared/platform-hotel-rules.js";

function hotelProduct(overrides: Record<string, unknown> = {}) {
  const day = (spots: unknown[], hotelCity?: string) => ({
    day: 1, hotel: PLATFORM_HOTEL_DESCRIPTION, hotelDescription: PLATFORM_HOTEL_DESCRIPTION,
    ...(hotelCity ? { hotelCity } : {}), spots, meals: "自理",
  });
  return {
    basicInfo: { meetingCity: "日喀则", destinationCity: "日喀则", days: 2, nights: 1, province: "西藏" },
    operations: { hotelMatchingMode: "rules", hotelRules: defaultPlatformHotelRules() },
    itinerary: [
      day([{ name: "珠峰绒布冰川遗迹", poiName: "珠峰绒布冰川遗迹", poiId: 76353, province: "西藏", city: "日喀则", district: "定日" }], "珠峰"),
      { day: 2, hotel: "无", hotelDescription: "无", spots: [], meals: "自理" },
    ],
    ...overrides,
  } as Record<string, any>;
}

test("住宿城市写成已核验景点名时阻塞，并给出去景点所属县市的可执行结论", () => {
  const gaps = extraPreparationGaps(hotelProduct()).filter(gap => gap.code === "hotel");
  const cityGap = gaps.find(gap => gap.label.startsWith("住宿城市"));
  assert.ok(cityGap, "必须有住宿城市缺口");
  assert.match(cityGap!.detail, /「珠峰」是当天已核验景点/u);
  assert.match(cityGap!.detail, /「定日」/u);
});

test("住宿城市写成乡镇名时阻塞，行政短名不误判", () => {
  const town = hotelProduct();
  town.itinerary[0].hotelCity = "狮泉河镇";
  assert.ok(extraPreparationGaps(town).some(gap => /乡镇或景区名/u.test(gap.detail)));
  for (const city of ["定日", "噶尔", "日喀则"]) {
    const product = hotelProduct();
    product.itinerary[0].hotelCity = city;
    assert.equal(extraPreparationGaps(product).some(gap => gap.label.startsWith("住宿城市")), false, city);
  }
});

test("集合城市与接团城市不一致时阻塞", () => {
  const product = hotelProduct();
  product.basicInfo.meetingCity = "阿里";
  product.basicInfo.destinationCity = "阿里";
  product.operations.pickupCity = "拉萨";
  const gap = extraPreparationGaps(product).find(item => item.label === "集合城市");
  assert.ok(gap, "必须有集合城市缺口");
  assert.match(gap!.detail, /接团城市是「拉萨」/u);
  assert.match(gap!.detail, /本品集合城市是「阿里」|产品集合城市是「阿里」/u);
});

test("区域统称别名、站点名、异地大交通与同城接团都不误判", () => {
  const cases: Array<Record<string, unknown>> = [
    { meetingCity: "潮汕", destinationCity: "潮汕", pickupCity: "汕头" },
    { meetingCity: "广安", destinationCity: "广安", pickupCity: "广安动车站" },
    { meetingCity: "西宁", destinationCity: "西宁", pickupCity: "西宁" },
  ];
  for (const basic of cases) {
    const product = hotelProduct();
    product.basicInfo = { ...product.basicInfo, ...basic };
    product.operations = { ...product.operations, pickupCity: (basic as any).pickupCity,
      trafficLine: { enabled: true, variants: ["flightRoundTrip"], arrivalCity: "西宁", departureCity: "敦煌" } };
    assert.equal(extraPreparationGaps(product).some(gap => gap.label === "集合城市"), false,
      JSON.stringify(basic));
  }
});
