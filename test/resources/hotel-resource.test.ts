import test from "node:test";
import assert from "node:assert/strict";
import { firstHotelResource, hotelResourceQuery } from "../../src/main/operations/hotel-resource.js";
import { hotelCandidateMatchesTier, hotelDiamondFromTier } from "../../src/shared/hotel-tiers.js";
import { ctripResourceSegments, hotelStayGroups } from "../../src/main/automation/ctrip/hotel-resource-api.js";

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

test("连续同城且候选 ID 顺序相同的两晚合并为一个资源行程段", () => {
  const candidates = (ids: number[]) => ids.map((hotelId) => ({ hotelId, hotelName: `酒店${hotelId}` }));
  const segments = ctripResourceSegments([
    { day: 1, hotelCandidates: candidates([1, 2, 3, 4, 5]) },
    { day: 2, hotelCandidates: candidates([1, 2, 3, 4, 5]) },
  ], [{ segmentId: "segment-1", segmentBase: { stayNights: 2 } }]);
  assert.deepEqual(segments, [{ day: 1, segmentId: "segment-1", candidates: candidates([1, 2, 3, 4, 5]) }]);
});

test("同城相邻但候选 ID 或顺序不同必须拆成独立资源行程段", () => {
  const candidates = (ids: number[]) => ids.map((hotelId) => ({ hotelId, hotelName: `酒店${hotelId}`, cityName: "潮州" }));
  assert.deepEqual(hotelStayGroups([
    { day: 3, hotelCandidates: candidates([1, 2, 3, 4, 5]) },
    { day: 4, hotelCandidates: candidates([6, 7, 8, 9, 10]) },
  ], true), [
    { cityName: "潮州", nights: 1 },
    { cityName: "潮州", nights: 1 },
  ]);
  assert.deepEqual(hotelStayGroups([
    { day: 3, hotelCandidates: candidates([1, 2, 3, 4, 5]) },
    { day: 4, hotelCandidates: candidates([2, 1, 3, 4, 5]) },
  ], true), [
    { cityName: "潮州", nights: 1 },
    { cityName: "潮州", nights: 1 },
  ]);
});

test("已合并资源段却覆盖不同携程候选时拒绝静默取首晚", () => {
  const candidates = (ids: number[]) => ids.map((hotelId) => ({ hotelId, hotelName: `酒店${hotelId}` }));
  assert.throws(() => ctripResourceSegments([
    { day: 3, hotelCandidates: candidates([1, 2, 3, 4, 5]) },
    { day: 4, hotelCandidates: candidates([6, 7, 8, 9, 10]) },
  ], [{ segmentId: "segment-1", segmentBase: { stayNights: 2 } }]), /候选不一致/);
});

test("携程分段拒绝非整数或重复酒店 ID", () => {
  assert.throws(() => hotelStayGroups([
    { day: 1, hotelCandidates: [{ hotelId: Number.NaN, cityName: "潮州" }] },
  ], true), /候选 ID 无效或重复/);
  assert.throws(() => hotelStayGroups([
    { day: 1, hotelCandidates: [{ hotelId: 1, cityName: "潮州" }, { hotelId: 1, cityName: "潮州" }] },
  ], true), /候选 ID 无效或重复/);
});

test("住宿资源段按连续住宿城市拆分，保留同城连续晚数", () => {
  assert.deepEqual(hotelStayGroups([
    { day: 1, hotelCandidates: [{ cityName: "成都" }] },
    { day: 2, hotelCandidates: [{ cityName: "成都" }] },
    { day: 3, hotelCandidates: [{ cityName: "都江堰" }] },
  ]), [
    { cityName: "成都", nights: 2 },
    { cityName: "都江堰", nights: 1 },
  ]);
});
