import test from "node:test";
import assert from "node:assert/strict";

import { ensureItineraryApi } from "../../src/main/automation/ctrip/itinerary-api.ts";
import {
  baseProductNoHotel,
  callLog,
  clearRouteHandlers,
  installFetchStub,
  installHandlersForFieldMismatch,
  makeFakePage,
  makeHandlers,
  resetCallLog,
  routeHandlers,
  uninstallFetchStub,
} from "./itinerary-api.test-helpers.ts";

test.beforeEach(() => {
  resetCallLog();
  installFetchStub();
});

test.afterEach(() => clearRouteHandlers());
test.after(() => uninstallFetchStub());

test("空产品：模板响应缺 template 时立即失败", async () => {
  Object.assign(routeHandlers, makeHandlers({
    emptyProduct: true,
    templatePayloadOverride: { ResponseStatus: { Ack: "Success", Errors: [] } },
  }));
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"),
    /响应缺 template 字段/,
  );
});

test("空产品：template 为空对象时立即失败", async () => {
  Object.assign(routeHandlers, makeHandlers({
    emptyProduct: true,
    templatePayloadOverride: {
      ResponseStatus: { Ack: "Success", Errors: [] },
      template: {},
    },
  }));
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"),
    /template 为空对象/,
  );
});

test("checkTourDaily 字符串中的 18 位 tourInfoId 不丢精度", async () => {
  Object.assign(routeHandlers, makeHandlers({ readbackOverrides: { hotelName: () => "" } }));
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: body.saveType === 8
      ? body.tourDaily
      : String(body.tourDaily).replace(/"tourInfoId":"?[^"]+"?/, '"tourInfoId":409226120750235682'),
  });
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  assert.equal(result.tourInfoId, "409226120750235682");
});

test("tourInfoId=0 时继续选择精确的 previewTourInfoId", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    templateId: 3,
    tourInfos: [{
      tourInfoId: 0,
      previewTourInfoId: "409226120750235682",
      productId: 77035928,
      main: true,
      sort: 0,
    }],
  });
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const detailCall = callLog.find((c) => c.endpoint === "/restapi/soa2/20049/getTourDailyDetail.json");
  assert.equal((detailCall?.body as any).tourInfoId, "409226120750235682");
  assert.equal(
    callLog.some((c) => c.endpoint === "/restapi/soa2/20049/getDailyTemplateDetail"),
    false,
  );
  const firstCheck = callLog.find((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal((firstCheck?.body as any).saveType, 7);
  assert.equal((firstCheck?.body as any).productTourInfo.tourInfoId, 0);
  const previewDaily = JSON.parse((firstCheck?.body as any).tourDaily);
  assert.equal(previewDaily.tourInfoId, 0);
  assert.equal(previewDaily.isModify, true);
  assert.equal("productId" in previewDaily, false);
});
