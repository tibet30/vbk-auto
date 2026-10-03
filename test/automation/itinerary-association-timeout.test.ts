import assert from "node:assert/strict";
import test from "node:test";
import { ensureItineraryApi } from "../../src/main/automation/ctrip/itinerary-api.js";
import {
  baseProductNoHotel, callLog, clearRouteHandlers, installFetchStub,
  installHandlersForFieldMismatch, makeFakePage, resetCallLog, routeHandlers, uninstallFetchStub,
} from "./itinerary-api.test-helpers.js";

for (const scenario of ["saved", "mismatch", "business-error"] as const) {
  test(`association timeout reconciliation: ${scenario}`, async () => {
    installFetchStub(); resetCallLog();
    installHandlersForFieldMismatch({
      hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00",
      title: i => scenario === "mismatch" ? "错误行程" : i === 0 ? "第1天" : "第2天",
    });
    routeHandlers["/restapi/soa2/15638/saveProductTourInfo"] = () => {
      throw new Error(scenario === "business-error" ? "VBK 业务拒绝" : "VBK 行程关联保存浏览器请求超时（15000ms）");
    };
    try {
      const action = () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
      if (scenario === "saved") assert.equal((await action()).days, 2);
      else await assert.rejects(action);
      assert.equal(callLog.filter(call => call.endpoint.endsWith("saveProductTourInfo")).length, 1);
      assert.equal(callLog.filter(call => call.endpoint.endsWith("getProductTourInfoList")).length,
        scenario === "business-error" ? 1 : 2);
    } finally { clearRouteHandlers(); uninstallFetchStub(); }
  });
}

for (const mismatch of [false, true]) {
  test(`previous association timeout recovery is read-only, mismatch=${mismatch}`, async () => {
    installFetchStub(); resetCallLog();
    installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: i => mismatch ? "错误行程" : i === 0 ? "第1天" : "第2天" });
    try {
      const action = () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928", { readOnlyBeforeWrite: true });
      if (mismatch) await assert.rejects(action); else assert.equal((await action()).days, 2);
      assert.equal(callLog.filter(call => /save|checkTourDaily/.test(call.endpoint)).length, 0);
    } finally { clearRouteHandlers(); uninstallFetchStub(); }
  });
}
