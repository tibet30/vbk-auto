import test from "node:test";
import assert from "node:assert/strict";
import { ensureBasicInfoApi } from "../../src/main/automation/ctrip/basic-info/api.js";
import { advanceSavedProductWizard } from "../../src/main/automation/ctrip/traffic-line/wizard-recovery.js";

function client(readbackGrade = "T", sourceVisibility?: string, readbackVisibility?: string | null) {
  const calls: any[] = [];
  let saved: any;
  const source = { baseInfo: { productId: 1, vendorId: 1, isAutoCalculateProductLevel: "F" }, bookingControls: { forChild: "T", localInfoID: 3, vendorComplainContactId: 11, vendorBookingContactId: 12, vendorBookingEmergencyContactId: 13 }, meta: { nameJoinRuleDto: { pattern: "私家团" } } };
  Object.assign(source.bookingControls, { isPublicEmergencyContact: sourceVisibility });
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    calls.push(request);
    const path = request.endpoint.split("/").at(-1);
    let payload: any;
    switch (path) {
      case "getProductBaseInfo": payload = saved ? { ...saved, baseInfo: { ...saved.baseInfo, isAutoCalculateProductLevel: readbackGrade }, bookingControls: {
        ...saved.bookingControl,
        ...(readbackVisibility !== undefined ? { isPublicEmergencyContact: readbackVisibility } : {}),
      }, nameAreas: saved.nameAreaRules } : source; break;
      case "getProviderLocalInfo": payload = { localInfoDtos: [{ localInfoID: 3, localInfoName: "地接社", active: "T" }] }; break;
      case "suggestDepartureCity": payload = { cities: [{ cityId: 1, cityName: "太原", provinceName: "山西", countryId: 1, countryName: "中国" }] }; break;
      case "getProductLinesByDestinationCityId": payload = { productLineDtos: [{ lineId: 9, lineName: "内蒙+东北" }] }; break;
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

test("私家团基本信息实际保存链：自动打钻是，主标题收费景点，副标题固定服务", async () => {
  const c = client();
  await ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true });
  const saved = c.saved();
  assert.equal(saved.baseInfo.isAutoCalculateProductLevel, "T");
  assert.equal(saved.baseInfo.mainName, "晋祠2日1晚私家团");
  assert.deepEqual(saved.nameAreaRules.map((rule: any) => rule.pOIScenicSpotID), ["2"]);
  assert.match(saved.baseInfo.subName, /^一单一团\+24h线上管家/);
  assert.doesNotMatch(saved.baseInfo.subName, /晋祠/);
  assert.equal(c.calls.filter(call => call.endpoint.endsWith("getProductBaseInfo")).length, 2);
});

test("平台回读自动打钻仍为否时拒绝报成功", async () => {
  const c = client("F");
  await assert.rejects(ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true }), /回读/);
});

test("所有产品形态均固定对客展示紧急联系人，不沿用旧值或缺省值", async () => {
  for (const productForm of ["privateTour", "groupTour", "freeTravel"]) {
    for (const original of ["F", "T", ""]) {
      const c = client("T", original || undefined);
      await ensureBasicInfoApi(c.page as any, { ...product, sales: { productForm } }, "1", butler, "400-test", { skipProductLine: true });
      assert.equal(c.saved().bookingControl.isPublicEmergencyContact, "T");
      assert.equal(c.saved().bookingControl.vendorBookingEmergencyContactId, 13);
    }
  }
});

test("远端未保存对客展示紧急联系人时，回读拒绝报成功", async () => {
  for (const actual of ["F", null]) {
    const c = client("T", "F", actual);
    await assert.rejects(ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true }), /isPublicEmergencyContact/);
  }
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
  const c = client("F");
  await assert.rejects(ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test", { skipProductLine: true }), /isAutoCalculateProductLevel（期望 "T"，实际 "F"）/);
});

test("线路审核恢复保存基本信息时也固定展示紧急联系人", async () => {
  let saved: any;
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const endpoint = request.endpoint.split("/").at(-1);
    let payload: any;
    if (endpoint === "getProductBaseInfo") payload = {
      baseInfo: { productId: 1 }, nameAreas: [], meta: { saveStep: saved ? -60 : -80 },
      bookingControls: { isPublicEmergencyContact: "F", minPersonQuantity: 1, maxPersonQuantity: 10 },
    };
    else if (endpoint === "saveProductBaseInfo") { saved = request.body; payload = {}; }
    else throw new Error(`unexpected ${endpoint}`);
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} };
  } };
  await advanceSavedProductWizard(page as any, "1", { authorization: "submit-route-review" });
  assert.equal(saved.bookingControl.isPublicEmergencyContact, "T");
});

test("产品线无法匹配时不写 productLineID，基本信息照常保存并返回跳过原因", async () => {
  const c = client();
  const result = await ensureBasicInfoApi(c.page as any, product, "1", butler, "400-test");
  assert.equal("productLineID" in c.saved().baseInfo, false);
  assert.equal(result.productLineSkipped, true);
  assert.match(result.productLineSkipReason ?? "", /平台可选：内蒙\+东北/);
});
