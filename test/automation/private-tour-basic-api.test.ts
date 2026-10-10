import test from "node:test";
import assert from "node:assert/strict";
import { ensureBasicInfoApi } from "../../src/main/automation/ctrip/basic-info/api.js";

function client(readbackGrade = "F") {
  const calls: any[] = [];
  let saved: any;
  const source = { baseInfo: { productId: 1, vendorId: 1, isAutoCalculateProductLevel: "T" }, bookingControls: { forChild: "T", localInfoID: 3, vendorComplainContactId: 11, vendorBookingContactId: 12, vendorBookingEmergencyContactId: 13 }, meta: { nameJoinRuleDto: { pattern: "私家团" } } };
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    calls.push(request);
    const path = request.endpoint.split("/").at(-1);
    let payload: any;
    switch (path) {
      case "getProductBaseInfo": payload = saved ? { ...saved, baseInfo: { ...saved.baseInfo, isAutoCalculateProductLevel: readbackGrade }, bookingControls: saved.bookingControl, nameAreas: saved.nameAreaRules } : source; break;
      case "getProviderLocalInfo": payload = { localInfoDtos: [{ localInfoID: 3, localInfoName: "地接社", active: "T" }] }; break;
      case "suggestDepartureCity": payload = { cities: [{ cityId: 1, cityName: "太原", provinceName: "山西", countryId: 1, countryName: "中国" }] }; break;
      case "getExtNumberList": payload = { extNumberDtos: [{ extNumberId: 5, extNumber: "400-test" }] }; break;
      case "searchProviderContactCardList": payload = { contactCardList: [{ contactCardId: 6, contactCardName: "管家" }] }; break;
      case "saveProductBaseInfo": saved = request.body; payload = {}; break;
      default: throw new Error(`unexpected ${path}`);
    }
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} as any };
  } };
  return { page, calls, saved: () => saved };
}
const product = { sales: { productForm: "privateTour" }, basicInfo: { days: 2, nights: 1, meetingCity: "太原", destinationCity: "太原", province: "山西",
  subtitle: "晋祠+古城2日私家团｜木构与壁画探访", supplierProductName: "供应商名称", supplierProductCode: "CODE", operationNotes: "按行程安排" },
  operations: { advanceBooking: { days: 1, time: "18:00" } }, itinerary: [{ day: 1, title: "游览", spots: [
    { name: "古城", poiId: 1, ticketType: { key: 2 } }, { name: "晋祠", poiId: 2, ticketType: { key: 1 } },
  ] }] };
const butler = { contactCardId: 6, providerId: 1, displayName: "管家" } as any;

test("私家团基本信息实际保存链：自动打钻否，主标题收费景点，副标题固定服务", async () => {
  const c = client();
  await ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true });
  const saved = c.saved();
  assert.equal(saved.baseInfo.isAutoCalculateProductLevel, "F");
  assert.equal(saved.baseInfo.mainName, "晋祠2日1晚私家团");
  assert.deepEqual(saved.nameAreaRules.map((rule: any) => rule.pOIScenicSpotID), ["2"]);
  assert.match(saved.baseInfo.subName, /^一单一团\+24h线上管家/);
  assert.doesNotMatch(saved.baseInfo.subName, /晋祠/);
  assert.equal(c.calls.filter(call => call.endpoint.endsWith("getProductBaseInfo")).length, 2);
});

test("平台回读自动打钻仍为是时拒绝报成功", async () => {
  const c = client("T");
  await assert.rejects(ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true }), /回读/);
});

test("儿童零价不启用儿童可订，正价启用，并通过保存回读", async () => {
  for (const child of [0, 600]) {
    const c = client();
    await ensureBasicInfoApi(c.page as any, { ...product, commercial: { pricing: { child } } }, "1", butler, "400-test", { skipProductLine: true });
    assert.equal(c.saved().bookingControl.forChild, child > 0 ? "T" : "F");
  }
});

test("平台静默清理乘号：保存前规范化分隔符，远端精确回读仍必须通过", async () => {
  const c = client();
  await ensureBasicInfoApi(c.page as any, { ...product, basicInfo: { ...product.basicInfo, subtitle: "秦岭秘境×汉中人文，温泉启程与山地古镇体验" } }, "1", butler, "400-test", { skipProductLine: true });
  assert.match(c.saved().baseInfo.subName, /秦岭秘境\+汉中人文/);
  assert.doesNotMatch(c.saved().baseInfo.subName, /×/);
});

test("基本信息失败提供字段差异，不能只返回无法定位的笼统错误", async () => {
  const c = client("T");
  await assert.rejects(ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true }), /isAutoCalculateProductLevel（期望 "F"，实际 "T"）/);
});
