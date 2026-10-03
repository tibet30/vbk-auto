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

test("首建空草稿缺模板时禁止写入", async () => {
  Object.assign(routeHandlers, makeHandlers({
    emptyProduct: true,
    templatePayloadOverride: { ResponseStatus: { Ack: "Success", Errors: [] } },
  }));
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"),
    /模板查询响应缺 template 字段/,
  );
  assert.equal(callLog.some((call) => /checkTourDaily|saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});

test("首建空草稿模板为空时禁止写入", async () => {
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
  assert.equal(callLog.some((call) => /checkTourDaily|saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});

test("checkTourDaily 字符串中的 18 位 tourInfoId 不丢精度", async () => {
  const handlers = makeHandlers({ readbackOverrides: { hotelName: () => "" } });
  const list = handlers["/restapi/soa2/15638/getProductTourInfoList"];
  handlers["/restapi/soa2/15638/getProductTourInfoList"] = (body: any) => {
    const payload = list(body);
    payload.tourInfos[0].draftTourInfoId = "409226120750235682";
    return payload;
  };
  handlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] }, tourInfoId: "409226120750235682",
  });
  Object.assign(routeHandlers, handlers);
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: String(body.tourDaily).replace(/"tourInfoId":"?[^"]+"?/, '"tourInfoId":409226120750235682'),
  });
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  assert.equal(result.tourInfoId, "409226120750235682");
  const detailSave = callLog.find((call) => call.endpoint === "/restapi/soa2/20049/saveTourDailyDetail.json");
  assert.equal((detailSave?.body as any).tourInfo.tourInfoId, "409226120750235682");
});

test("tourInfoId=0 时继续选择精确的 draftTourInfoId", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    templateId: 3,
    tourInfos: [{
      tourInfoId: 0,
      draftTourInfoId: "417899634191761447",
      previewTourInfoId: "409226120750235682",
      draftTourInfoStatus: 1,
      productId: 77035928,
      main: true,
      sort: 0,
    }],
  });
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] }, tourInfoId: "417899634191761447",
  });
  const check = routeHandlers["/restapi/soa2/15638/checkTourDaily"];
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => {
    const payload = check(body);
    const daily = JSON.parse(payload.tourDaily);
    daily.tourInfoId = "417899634191761447";
    return { ...payload, tourDaily: JSON.stringify(daily) };
  };
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const detailCall = callLog.find((c) => c.endpoint === "/restapi/soa2/20049/getTourDailyDetail.json");
  assert.equal((detailCall?.body as any).tourInfoId, "417899634191761447");
  assert.equal(
    callLog.some((c) => c.endpoint === "/restapi/soa2/20049/getDailyTemplateDetail"),
    false,
  );
  const firstCheck = callLog.find((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal((firstCheck?.body as any).saveType, 2);
  assert.equal((firstCheck?.body as any).productTourInfo.tourInfoId, 0);
  const previewDaily = JSON.parse((firstCheck?.body as any).tourDaily);
  assert.equal(previewDaily.tourInfoId, "417899634191761447");
  // Normal UI draft saves send isModify=true even when the formal ID is 0;
  // retain the assertion above that this branch reads the linked draft ID.
  assert.equal(previewDaily.isModify, true);
  assert.equal(previewDaily.productId, 77035928);
});
