import test from "node:test";
import assert from "node:assert/strict";
import { ensureBasicInfoApi } from "../../src/main/automation/ctrip/basic-info/api.js";
import { runBasicInfoSaveWithCopyRepair } from "../../src/main/automation/automation.main/basic-info-copy-repair.js";

const KEYWORD = "冈仁波齐";
const REJECTION = { ResponseStatus: { Ack: "Failure", Errors: [
  { ErrorCode: "50016002", Message: `300019:操作说明存在非法关键词：${KEYWORD}` },
] } };

/** 完整基本信息保存链：第一次保存被平台以非法关键词驳回，之后按清理后的文案保存成功。 */
function client(options: { rejectFirstSave?: boolean } = {}) {
  const calls: any[] = [];
  const saves: any[] = [];
  let saved: any;
  const source = {
    baseInfo: { productId: 1, vendorId: 1 },
    bookingControls: { forChild: "T", localInfoID: 3, vendorComplainContactId: 11, vendorBookingContactId: 12, vendorBookingEmergencyContactId: 13 },
    meta: { nameJoinRuleDto: { pattern: "私家团" } },
  };
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    calls.push(request);
    const path = request.endpoint.split("/").at(-1);
    let payload: any;
    switch (path) {
      case "getProductBaseInfo":
        payload = saved
          ? { ...saved, baseInfo: { ...saved.baseInfo }, bookingControls: saved.bookingControl, nameAreas: saved.nameAreaRules }
          : source;
        break;
      case "getProviderLocalInfo": payload = { localInfoDtos: [{ localInfoID: 3, localInfoName: "地接社", active: "T" }] }; break;
      case "suggestDepartureCity": payload = { cities: [{ cityId: 1, cityName: "拉萨", provinceName: "西藏", countryId: 1, countryName: "中国" }] }; break;
      case "getExtNumberList": payload = { extNumberDtos: [{ extNumberId: 5, extNumber: "400-test" }] }; break;
      case "searchProviderContactCardList": payload = { contactCardList: [{ contactCardId: 6, contactCardName: "管家" }] }; break;
      case "saveProductBaseInfo":
        saves.push(request.body);
        if (options.rejectFirstSave && saves.length === 1) {
          return { status: 200, payload: REJECTION, durationMs: 1, ctx: {} as any };
        }
        saved = request.body; payload = {}; break;
      default: throw new Error(`unexpected ${path}`);
    }
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} as any };
  } };
  return { page, calls, saves };
}

function product() {
  return {
    sales: { productForm: "privateTour" },
    basicInfo: {
      days: 2, nights: 1, meetingCity: "拉萨", destinationCity: "拉萨", province: "西藏",
      subtitle: "阿里南线冰川遗址私家团｜高原湖泊与雪山", supplierProductName: "供应商名称",
      supplierProductCode: "CODE",
      operationNotes: "目的地为拉萨，行程覆盖羊卓雍措、普莫雍措至冈仁波齐、札达土林一线的冰川遗址主题。",
    },
    operations: { advanceBooking: { days: 1, time: "18:00" } },
    itinerary: [{ day: 1, title: "游览", spots: [{ name: "羊卓雍措", poiId: 1, ticketType: { key: 2 } }] }],
  };
}

const butler = { contactCardId: 6, providerId: 1, displayName: "管家" } as any;

test("基本信息保存被平台以非法关键词驳回时，自动清理文案并重试成功", async () => {
  const c = client({ rejectFirstSave: true });
  const value = product();
  const learned: any[] = [];
  let persisted = 0;
  const logs: string[] = [];

  const result = await runBasicInfoSaveWithCopyRepair({
    product: value,
    save: () => ensureBasicInfoApi(c.page as any, value, "1", butler, "400-test", { skipProductLine: true }),
    persist: () => { persisted += 1; },
    log: (message) => { logs.push(message); },
    onLearned: (words, labels, detail) => { learned.push({ words, labels, detail }); },
  });

  assert.equal(result.savedWith, "basic-info-api");
  assert.equal(c.saves.length, 2, "第一轮被驳回后必须重试一次保存");
  assert.equal(c.saves[0].baseInfo.operationNote.includes(KEYWORD), true);
  assert.equal(String(c.saves[1].baseInfo.operationNote).includes(KEYWORD), false);
  assert.equal(String(c.saves[1].baseInfo.operationNote).includes("羊卓雍措"), true, "只删除平台点名的词");
  assert.equal(persisted, 1);
  assert.deepEqual(learned.map(entry => [entry.words, entry.labels]), [[[KEYWORD], ["操作说明"]]]);
  assert.match(learned[0].detail, /非法关键词：冈仁波齐/);
  assert.ok(logs.some(line => /已清理后重试保存/.test(line)));
  assert.equal(value.basicInfo.operationNotes.includes(KEYWORD), false);
});

test("平台未驳回时保持原有一次保存行为", async () => {
  const c = client();
  const value = product();
  let persisted = 0;
  await runBasicInfoSaveWithCopyRepair({
    product: value,
    save: () => ensureBasicInfoApi(c.page as any, value, "1", butler, "400-test", { skipProductLine: true }),
    persist: () => { persisted += 1; },
    log: () => {},
  });
  assert.equal(c.saves.length, 1);
  assert.equal(persisted, 0);
  assert.equal(String(c.saves[0].baseInfo.operationNote).includes(KEYWORD), true);
});
