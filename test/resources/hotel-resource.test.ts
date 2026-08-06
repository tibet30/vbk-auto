import test from "node:test";
import assert from "node:assert/strict";
import { firstHotelResource, hotelResourceQuery } from "../../src/main/operations/hotel-resource.js";
import { hotelCandidateMatchesTier, hotelDiamondFromTier } from "../../src/shared/hotel-tiers.js";

test("酒店资源匹配词由目的城市和酒店等级组成", () => {
  assert.equal(hotelResourceQuery({
    product: {
      basicInfo: { destinationCity: "太原" },
      operations: { hotelTier: "当地5钻酒店/-38" },
    },
  }), "太原5钻酒店");
});

test("缺少酒店等级时仍可按城市搜索酒店", () => {
  assert.equal(hotelResourceQuery({ product: { basicInfo: { meetingCity: "厦门" } } }), "厦门酒店");
});

test("资源列表只从酒店类别中选择目的城市匹配项", () => {
  const selected = firstHotelResource({ resources: [
    { resourceId: 1, resourceName: "太原5座用车", categoryName: "用车", destinationCityName: "太原" },
    { resourceId: 2, resourceName: "厦门海景房", categoryName: "酒店", destinationCityName: "厦门", vendorResourceCode: "XM-HOTEL-01" },
    { resourceId: 3, resourceName: "太原古城客栈", categoryName: "酒店", destinationCityName: "太原", vendorResourceCode: "TY-HOTEL-01" },
  ] }, "太原");
  assert.deepEqual(selected, { source: "vbk", resourceId: 3, resourceName: "太原古城客栈", supplierCode: "TY-HOTEL-01", roomType: undefined });
});

test("资源配置酒店必须与行程钻级严格一致", () => {
  assert.equal(hotelDiamondFromTier("当地5钻酒店/-38"), 5);
  assert.equal(hotelCandidateMatchesTier("太原星河湾酒店 太原 【豪华型，5钻，高质量】", "当地5钻酒店/-38"), true);
  assert.equal(hotelCandidateMatchesTier("山西国贸大饭店 太原 【豪华型，5星，高质量】", "当地5钻酒店/-38"), true);
  assert.equal(hotelCandidateMatchesTier("太原景华酒店 太原 【舒适型，3钻】", "当地4钻酒店/-4"), false);
  assert.equal(hotelCandidateMatchesTier("某四星酒店 【高档型，4星】", "当地4钻酒店/-4"), false);
});
