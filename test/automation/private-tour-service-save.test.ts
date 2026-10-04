import test from "node:test";
import assert from "node:assert/strict";
import { ensureItineraryApi } from "../../src/main/automation/ctrip/itinerary-api.js";
import { ensurePackageApi } from "../../src/main/automation/ctrip/package-api.js";
import { baseProduct, makeFakePage, makeHandlers, routeHandlers, callLog, resetCallLog, clearRouteHandlers, installFetchStub, uninstallFetchStub } from "./itinerary-api.test-helpers.js";

test.beforeEach(() => { resetCallLog(); installFetchStub(); });
test.afterEach(() => { clearRouteHandlers(); uninstallFetchStub(); });
for (const field of ["traffic", "hotelNote"] as const) {
  test(`行程校验删除${field}时阻断后续保存`, async () => {
    const handlers = makeHandlers();
    const check = handlers["/restapi/soa2/15638/checkTourDaily"]!;
    handlers["/restapi/soa2/15638/checkTourDaily"] = body => {
      const response = check(body);
      const draft = JSON.parse(response.tourDaily);
      for (const day of draft.tourDailyDescriptions) {
        if (field === "traffic") day.tourDailyInfos = day.tourDailyInfos.filter((info: any) => info.activeType?.key !== 8);
        else for (const info of day.tourDailyInfos) if (info.activeType?.key === 1) info.description = "酒店甲";
      }
      return { ...response, tourDaily: JSON.stringify(draft) };
    };
    Object.assign(routeHandlers, handlers);
    await assert.rejects(ensureItineraryApi(makeFakePage() as any, baseProduct as any, "1"), /校验响应改写白名单字段/);
    assert.equal(callLog.some(call => /saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
  });
}

function packageClient(retainWrongValue = false) {
  let current = { name: "旧套餐", needShuttle: "T", vendorResourceCode: "CODE", confirmHour: 4, isHotelResource: "F", resourceNameRule: { days: 2 } };
  const calls: any[] = [];
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    calls.push(request);
    const path = request.endpoint.split("/").at(-1);
    if (path === "savePackageItem") current = { ...request.body.packageInfo, ...(retainWrongValue ? { needShuttle: "T" } : {}) };
    else if (path !== "getPackageList") throw new Error(`unexpected ${path}`);
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...(path === "getPackageList" ? { itemList: [structuredClone(current)] } : {}) }, durationMs: 1, ctx: {} as any };
  } };
  return { page, calls, current: () => current };
}
const packageProduct = { sales: { productForm: "privateTour" }, basicInfo: { days: 2, supplierProductCode: "CODE" }, commercial: { packageName: "新套餐" }, itinerary: [{}, {}] };

test("已有套餐需要接送备注从是改为否，并独立回读", async () => {
  const client = packageClient();
  await ensurePackageApi(client.page, packageProduct, "1");
  assert.equal(client.current().needShuttle, "F");
  assert.equal(client.calls.filter(call => call.endpoint.endsWith("getPackageList")).length, 2);
});
test("平台保留需要接送备注为是时拒绝成功", async () => {
  const client = packageClient(true);
  await assert.rejects(ensurePackageApi(client.page, packageProduct, "1"), /需要接送备注/);
});
