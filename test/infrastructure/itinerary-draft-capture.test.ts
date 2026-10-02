import assert from "node:assert/strict";
import test from "node:test";
import { ItineraryDraftCapture, type DebuggerTarget } from "../../src/main/infrastructure/itinerary-draft-capture.js";

class FakeDebugger implements DebuggerTarget {
  attached = false;
  enabled = false;
  failEnable = false;
  detached = 0;
  private listeners = new Set<(event: unknown, method: string, params: unknown) => void>();
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; this.detached += 1; }
  private responses = new Map<string, { body: string; base64Encoded?: boolean }>();
  async sendCommand(command: string, params?: Record<string, unknown>) {
    if (command === "Network.enable") {
      if (this.failEnable) throw new Error("Network enable failed");
      this.enabled = true;
      return {};
    }
    assert.equal(command, "Network.getResponseBody");
    return this.responses.get(String(params?.requestId)) ?? { body: "{}" };
  }
  on(_event: "message", listener: (event: unknown, method: string, params: unknown) => void) { this.listeners.add(listener); }
  removeListener(_event: "message", listener: (event: unknown, method: string, params: unknown) => void) { this.listeners.delete(listener); }
  emit(requestId: string, url: string, body: unknown) {
    for (const listener of this.listeners) listener({}, "Network.requestWillBeSent", { requestId, request: { url, postData: JSON.stringify(body) } });
  }
  emitRaw(requestId: string, url: string, postData: string) {
    for (const listener of this.listeners) listener({}, "Network.requestWillBeSent", { requestId, request: { url, postData } });
  }
  finish(requestId: string, response: unknown, base64Encoded = false) {
    const text = JSON.stringify(response);
    this.responses.set(requestId, {
      body: base64Encoded ? Buffer.from(text, "utf8").toString("base64") : text,
      ...(base64Encoded ? { base64Encoded: true } : {}),
    });
    for (const listener of this.listeners) listener({}, "Network.loadingFinished", { requestId });
  }
  listenerCount() { return this.listeners.size; }
}

const endpoints = {
  check: "https://online.ctrip.com/restapi/soa2/15638/checkTourDaily",
  detail: "https://online.ctrip.com/restapi/soa2/20049/saveTourDailyDetail.json",
  association: "https://online.ctrip.com/restapi/soa2/15638/saveProductTourInfo",
  relatedCopy: "https://online.ctrip.com/restapi/soa2/20049/copyTourInfoForDraft.json",
  unrelated: "https://online.ctrip.com/restapi/soa2/20049/otherProductMutation",
};
const target = (debuggerApi: FakeDebugger) => ({ debugger: debuggerApi });
const body = (productId: string | number) => ({
  saveType: 3,
  tourInfo: {
    productId, tourInfoId: 11, draftTourInfoId: 12, auditTourInfoId: 13,
    auditTourInfoStatus: "pending", draftTourInfoStatus: "saved", auditStatus: "pending",
    cookie: "must-not-capture", headers: { authorization: "must-not-capture" }, nested: { secret: "must-not-capture" },
  },
});

test("capture projects all observed save exchanges and waits for each response before cleanup", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  assert.equal(debuggerApi.enabled, true);
  const association = body(79189107);
  association.saveType = 7;
  debuggerApi.emit("check-1", endpoints.check, { saveType: 8, productTourInfo: association.tourInfo });
  debuggerApi.emit("detail-1", endpoints.detail, { tourInfo: association.tourInfo });
  debuggerApi.emit("association-1", endpoints.association, association);
  debuggerApi.finish("check-1", { tourDaily: JSON.stringify(association.tourInfo), secret: "must-not-capture" });
  debuggerApi.finish("detail-1", { tourInfo: association.tourInfo, token: "must-not-capture" });
  assert.equal(debuggerApi.listenerCount(), 1, "关联保存 response 未完成时不可提前清理");
  debuggerApi.finish("association-1", { result: association.tourInfo, headers: { authorization: "must-not-capture" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(debuggerApi.listenerCount(), 1, "完整第一组采样后仍须继续监听后续同产品请求");
  assert.equal(debuggerApi.attached, true);
  const associationPayload = capture.read()?.payload;
  assert.equal(associationPayload?.saveType, 7);
  assert.equal(associationPayload?.tourInfoId, 11);
  assert.deepEqual(associationPayload?.locations.saveType, ["body"]);
  assert.deepEqual(associationPayload?.locations.tourInfoId, ["tourInfo"]);
  assert.deepEqual(associationPayload?.versionValues.tourInfoId, [{ location: "tourInfo", value: 11 }]);
  assert.equal(associationPayload?.tourDailyType, "absent");
  assert.equal(capture.read()?.complete, true);
  assert.deepEqual(capture.read()?.missingSteps, []);
  const serialized = JSON.stringify(capture.read());
  assert.doesNotMatch(serialized, /cookie|authorization|secret|headers/i);
  capture.dispose();
  assert.equal(debuggerApi.listenerCount(), 0);
  assert.equal(debuggerApi.attached, false);
  assert.equal(capture.read()?.stopReason, "disposed");
});

test("capture cleans up its owned debugger when Network.enable fails", async (t) => {
  const debuggerApi = new FakeDebugger();
  debuggerApi.failEnable = true;
  await assert.rejects(new ItineraryDraftCapture().arm(target(debuggerApi), "79189107"), /Network enable failed/);
  assert.equal(debuggerApi.attached, false);
  assert.equal(debuggerApi.detached, 1);
  assert.equal(debuggerApi.listenerCount(), 0);
});

test("capture rejects an exact-endpoint request for another product", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  debuggerApi.emit("other", endpoints.association, body(79189108));
  assert.equal(capture.read()?.capturedAt, undefined);
  assert.equal(capture.read()?.complete, false);
  assert.equal(debuggerApi.listenerCount(), 1);
  capture.dispose();
});

test("capture discovers only product-or-version-related SOA copy endpoints with scalar metadata", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const current = body("79189107");
  debuggerApi.emit("check-current", endpoints.check, { saveType: 7, productTourInfo: current.tourInfo });
  debuggerApi.emit("copy-related", endpoints.relatedCopy, {
    saveType: 7, tourInfoId: 12, fromTourInfoId: 11,
    requestHeader: { authorization: "must-not-capture" }, cookie: "must-not-capture", extra: { secret: "must-not-capture" },
  });
  debuggerApi.emit("copy-other", endpoints.unrelated, { saveType: 7, tourInfoId: 12, productId: "other" });
  debuggerApi.finish("check-current", { tourDaily: JSON.stringify(current.tourInfo) });
  debuggerApi.finish("copy-related", { tourInfoId: 12, draftTourInfoId: 13 });
  debuggerApi.finish("copy-other", { tourInfoId: 999_999_999 });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = capture.read();
  capture.dispose();
  const related = snapshot?.exchanges?.find((exchange) => exchange.endpointName === "copyTourInfoForDraft");
  assert.equal(related?.step, "relatedSoa");
  assert.equal(related?.serviceId, "20049");
  assert.deepEqual(related?.requestFieldNames, ["extra", "fromTourInfoId", "saveType", "tourInfoId"]);
  assert.equal(snapshot?.exchanges?.some((exchange) => exchange.endpointName === "otherProductMutation"), false);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /must-not-capture|authorization|cookie|secret/i);
});

test("capture preserves a raw 18-digit ID when it discovers a version-related copy endpoint", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const formalId = "417816553915138158";
  const draftId = "417899634191761447";
  debuggerApi.emitRaw("bound-check", endpoints.check,
    `{"saveType":7,"productTourInfo":{"productId":"79189107","tourInfoId":${formalId},"draftTourInfoId":${draftId}}}`);
  debuggerApi.emitRaw("related-copy", endpoints.relatedCopy,
    `{"saveType":7,"tourInfoId":${draftId},"fromTourInfoId":${formalId}}`);
  debuggerApi.finish("bound-check", {});
  debuggerApi.finish("related-copy", {});
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = capture.read();
  capture.dispose();
  const related = snapshot?.exchanges?.find((exchange) => exchange.endpointName === "copyTourInfoForDraft");
  assert.deepEqual(related?.request.versionValues.tourInfoId, [{ location: "body", value: draftId }]);
  assert.deepEqual(related?.request.protocolValues.fromTourInfoId, [{ location: "body", value: formalId }]);
});

test("capture ignores malformed and primitive JSON post bodies without throwing", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  for (const body of [null, true, 1, "string", [], { tourInfo: null }]) {
    assert.doesNotThrow(() => debuggerApi.emit("malformed", endpoints.association, body));
  }
  assert.equal(capture.read()?.capturedAt, undefined);
  capture.dispose();
});

test("capture leaves an existing debugger attached after cleanup", async (t) => {
  const debuggerApi = new FakeDebugger();
  debuggerApi.attached = true;
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  debuggerApi.emit("existing", endpoints.association, body("79189107"));
  assert.equal(debuggerApi.attached, true);
  assert.equal(debuggerApi.detached, 0);
  capture.dispose();
});

test("dispose removes a pending capture listener", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  capture.dispose();
  assert.equal(debuggerApi.listenerCount(), 0);
  assert.equal(debuggerApi.attached, false);
});

test("pending capture times out and detaches only its own debugger", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture(1);
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(debuggerApi.listenerCount(), 0);
  assert.equal(debuggerApi.attached, false);
  assert.equal(capture.read()?.capturedAt, undefined);
});

test("capture ignores a same-window detail request whose version is unrelated to the bound check", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  debuggerApi.emit("check-current", endpoints.check, { saveType: 8, productTourInfo: body("79189107").tourInfo });
  debuggerApi.emit("detail-other", endpoints.detail, { tourInfo: { tourInfoId: "999999999999999999", draftTourInfoId: "999999999999999998" } });
  debuggerApi.emit("association-current", endpoints.association, body("79189107"));
  debuggerApi.finish("check-current", { tourDaily: JSON.stringify(body("79189107").tourInfo) });
  debuggerApi.finish("detail-other", { tourInfo: { tourInfoId: "999999999999999999" } });
  debuggerApi.finish("association-current", { result: body("79189107").tourInfo });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.read()?.capturedAt, undefined, "无同版本 detail 证据不可完成采样");
  assert.equal(debuggerApi.listenerCount(), 1);
  capture.dispose();
});

test("capture preserves an unquoted 18-digit response ID and decodes base64 JSON before projection", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const current = body("79189107");
  debuggerApi.emit("check-current", endpoints.check, { saveType: 8, productTourInfo: current.tourInfo });
  debuggerApi.emit("detail-current", endpoints.detail, { tourInfo: current.tourInfo });
  debuggerApi.emit("association-current", endpoints.association, current);
  debuggerApi.finish("check-current", { tourDaily: '{"tourInfoId":417816553915138158,"draftTourInfoId":417899634191761447}' }, true);
  debuggerApi.finish("detail-current", { tourInfo: current.tourInfo });
  debuggerApi.finish("association-current", { result: current.tourInfo });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.read()?.checkTourDaily?.[0]?.response?.tourInfoId, "417816553915138158");
  assert.deepEqual(capture.read()?.checkTourDaily?.[0]?.response?.versionValues.tourInfoId, [
    { location: "tourDaily", value: "417816553915138158" },
  ]);
  capture.dispose();
});

test("capture keeps a partial same-product association with an explicit missing-step result", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const current = body("79189107");
  current.saveType = 7;
  debuggerApi.emit("association-only", endpoints.association, current);
  debuggerApi.finish("association-only", { result: current.tourInfo });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.read()?.payload?.saveType, 7);
  assert.equal(capture.read()?.complete, false);
  assert.deepEqual(capture.read()?.missingSteps, ["checkTourDaily", "saveTourDailyDetail"]);
  capture.dispose();
});

test("capture projects only first gather airport and protocol flags for each record location", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const current = body("79189107");
  const daily = {
    tourInfoId: 11,
    isModify: true,
    fromTourInfoId: 10,
    tourDailyDescriptions: [{ tourDailyInfos: [{
      activeType: { key: 25, name: "集合" },
      tourDailyPackageGatherList: [{ airports: [{ code: "SWA", name: "揭阳潮汕机场" }] }],
    }, {
      activeType: { key: 1, name: "酒店" },
      tourDailyHotels: [{ hotel: { hotelId: 123, grade: { key: -38, name: "当地5钻酒店" } } }],
      packageHotels: [{ hotel: { hotelId: 456, grade: { key: -38, name: "当地5钻酒店" } } }],
    }], }],
  };
  debuggerApi.emit("check-current", endpoints.check, { saveType: 7, productTourInfo: current.tourInfo, tourDaily: JSON.stringify(daily) });
  debuggerApi.emit("detail-current", endpoints.detail, { saveType: 7, tourInfo: { ...daily, tourInfoId: 12 } });
  debuggerApi.emit("association-current", endpoints.association, { ...current, saveType: 7, tourDaily: JSON.stringify(daily) });
  debuggerApi.finish("check-current", { tourDaily: JSON.stringify({ ...daily, tourInfoId: 12 }) });
  debuggerApi.finish("detail-current", { tourInfoId: 12 });
  debuggerApi.finish("association-current", { result: current.tourInfo });
  await new Promise((resolve) => setImmediate(resolve));
  const check = capture.read()?.checkTourDaily?.[0]?.request;
  assert.deepEqual(check?.protocolValues.isModify, [{ location: "tourDaily", value: true }]);
  assert.deepEqual(check?.protocolValues.fromTourInfoId, [{ location: "tourDaily", value: 10 }]);
  assert.deepEqual(check?.protocolValues.firstGatherAirport, [{ location: "tourDaily", code: "SWA", name: "揭阳潮汕机场" }]);
  assert.deepEqual(check?.protocolValues.hotelShapes, [{
    location: "tourDaily", hotelInfoCount: 1, tourDailyHotelsCount: 1, packageHotelsCount: 1,
    hotelIdPresent: true, gradePresent: true,
  }]);
  assert.doesNotMatch(JSON.stringify(capture.read()), /tourDailyInfos|tourDailyDescriptions/);
  capture.dispose();
});

test("capture projects native fallback exchanges without retaining their raw bodies", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const current = body("79189107");
  const daily = {
    tourInfoId: 11, isModify: true,
    tourDailyDescriptions: [{ tourDailyInfos: [{
      activeType: { key: 25, name: "集合" },
      tourDailyPackageGatherList: [{ airports: [{ code: "SWA", name: "揭阳潮汕机场" }] }],
    }] }],
  };
  capture.observeNative(endpoints.check, "2026-10-01T12:00:00.000Z", { saveType: 7, productTourInfo: current.tourInfo, tourDaily: JSON.stringify(daily) }, {
    tourDaily: JSON.stringify({ ...daily, tourInfoId: 12 }),
  });
  capture.observeNative(endpoints.detail, "2026-10-01T12:00:01.000Z", { saveType: 7, tourInfo: { ...daily, tourInfoId: 12 } }, { tourInfoId: 12 });
  capture.observeNative(endpoints.association, "2026-10-01T12:00:02.000Z", { ...current, saveType: 7, tourDaily: JSON.stringify(daily) }, { result: current.tourInfo });
  const result = capture.read();
  assert.equal(result?.complete, true);
  assert.deepEqual(result?.exchanges?.map((exchange) => exchange.source), ["native", "native", "native"]);
  assert.deepEqual(result?.exchanges?.map((exchange) => exchange.serviceId), ["15638", "20049", "15638"]);
  assert.deepEqual(result?.checkTourDaily?.[0]?.request.protocolValues.firstGatherAirport, [
    { location: "tourDaily", code: "SWA", name: "揭阳潮汕机场" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /tourDailyDescriptions|must-not-capture/);
  capture.dispose();
});

test("capture retains a second complete same-product sequence and exposes latest compatibility fields", async (t) => {
  const debuggerApi = new FakeDebugger();
  const capture = new ItineraryDraftCapture();
  t.after(() => capture.dispose());
  await capture.arm(target(debuggerApi), "79189107");
  const current = body("79189107");
  const emitSequence = (prefix: string, airportCode: string, airportName: string) => {
    const daily = {
      tourInfoId: 11,
      tourDailyDescriptions: [{ tourDailyInfos: [{
        activeType: { key: 25, name: "集合" },
        tourDailyPackageGatherList: [{ airports: [{ code: airportCode, name: airportName }] }],
      }] }],
    };
    debuggerApi.emit(`${prefix}-check`, endpoints.check, { saveType: 7, productTourInfo: current.tourInfo, tourDaily: JSON.stringify(daily) });
    debuggerApi.emit(`${prefix}-detail`, endpoints.detail, { saveType: 7, tourInfo: { ...daily, tourInfoId: 12 } });
    debuggerApi.emit(`${prefix}-association`, endpoints.association, { ...current, saveType: 7, tourDaily: JSON.stringify(daily) });
    debuggerApi.finish(`${prefix}-check`, { tourDaily: JSON.stringify({ ...daily, tourInfoId: 12 }) });
    debuggerApi.finish(`${prefix}-detail`, { tourInfoId: 12 });
    debuggerApi.finish(`${prefix}-association`, { result: current.tourInfo });
  };
  emitSequence("first", "XMN", "高崎国际机场");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.read()?.complete, true);
  assert.equal(debuggerApi.listenerCount(), 1);
  emitSequence("second", "SWA", "揭阳潮汕机场");
  await new Promise((resolve) => setImmediate(resolve));
  const result = capture.read();
  assert.equal(result?.exchanges?.length, 6);
  assert.equal(result?.checkTourDaily?.length, 2);
  assert.deepEqual(result?.payload?.protocolValues.firstGatherAirport, [{ location: "tourDaily", code: "SWA", name: "揭阳潮汕机场" }]);
  assert.deepEqual(result?.saveTourDailyDetail?.request.protocolValues.firstGatherAirport, [{ location: "tourInfo", code: "SWA", name: "揭阳潮汕机场" }]);
  capture.dispose();
});
