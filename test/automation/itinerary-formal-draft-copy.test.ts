import test from "node:test";
import assert from "node:assert/strict";
import { ensureItineraryApi } from "../../src/main/automation/ctrip/itinerary-api.ts";
import { productSectionUrl } from "../../src/main/automation/constants.ts";
import {
  baseProductNoHotel, callLog, installFetchStub, uninstallFetchStub,
  installHandlersForFieldMismatch, makeFakePage, resetCallLog, clearRouteHandlers, routeHandlers,
} from "./itinerary-api.test-helpers.ts";

const formal = "418280784483401812";
const draft = "418283660941246551";
const preview = "418280043173707888";
const before = {
  productId: 77035928, main: true, sort: 0, tourInfoId: formal,
  auditTourInfoId: formal, previewTourInfoId: preview,
  draftTourInfoStatus: 1, auditTourInfoStatus: 2,
  auditStatus: { key: "A", value: "审核通过" },
};

function setup(change: (relation: Record<string, any>) => void = () => {}) {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  let calls = 0;
  const after = { ...before, draftTourInfoId: draft };
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfos: [calls++ ? after : before],
  });
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => {
    const relation = structuredClone(after);
    change(relation);
    return {
      ResponseStatus: { Ack: "Success" }, productTourInfo: relation,
      tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: draft }),
    };
  };
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = (body: any) => ({
    ResponseStatus: { Ack: "Success" }, tourInfoId: body.tourInfo.tourInfoId,
  });
}

test.beforeEach(() => { resetCallLog(); clearRouteHandlers(); installFetchStub(); });
test.afterEach(() => uninstallFetchStub());

test("approved formal template is copied into the server-created independent draft", async () => {
  setup();
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  assert.equal(result.tourInfoId, draft);
  const check = callLog.find((c) => c.endpoint.endsWith("/checkTourDaily"))!.body as any;
  assert.equal(check.saveType, 2);
  assert.equal(JSON.parse(check.tourDaily).tourInfoId, formal);
  const detail = callLog.find((c) => c.endpoint.endsWith("/saveTourDailyDetail.json"))!.body as any;
  assert.equal(detail.tourInfo.tourInfoId, draft);
  const association = callLog.find((c) => c.endpoint.endsWith("/saveProductTourInfo"))!.body as any;
  assert.equal(association.saveType, 2);
  assert.deepEqual(association.tourInfo, { ...before, draftTourInfoId: draft });
  assert.equal(JSON.parse(association.tourDaily).tourInfoId, formal, "matches captured normal UI association source");
});

for (const [name, change] of [
  ["missing server draft pointer", (r: any) => { delete r.draftTourInfoId; }],
  ["draft aliases formal", (r: any) => { r.draftTourInfoId = formal; }],
  ["audit status changes", (r: any) => { r.auditStatus = { key: "N", value: "未提交" }; }],
] as const) {
  test(`formal copy refuses ${name} before detail or association writes`, async () => {
    setup(change);
    await assert.rejects(() => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"), /独立草稿|未授权变化/);
    assert.equal(callLog.some((c) => /saveTourDailyDetail|saveProductTourInfo/.test(c.endpoint)), false);
  });
}

test("itinerary editor follows the editable next-step route", () => {
  assert.equal(productSectionUrl("79232466", "itinerary"), "https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=79232466&from=vbk");
});
