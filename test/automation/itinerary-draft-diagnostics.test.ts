import assert from "node:assert/strict";
import test from "node:test";
import { readItineraryDraftDiagnostic } from "../../src/main/automation/ctrip/itinerary-api/draft-diagnostics.js";
import {
  clearRouteHandlers, installFetchStub, makeFakePage, routeHandlers, uninstallFetchStub,
} from "./itinerary-api.test-helpers.js";

test.beforeEach(() => { clearRouteHandlers(); installFetchStub(); });
test.afterEach(() => clearRouteHandlers());
test.after(() => uninstallFetchStub());

test("diagnostic reads every explicitly linked version and projects only write-guard fields", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" },
    tourInfos: [{
      tourInfoId: 101, draftTourInfoId: 102, auditTourInfoId: 103, previewTourInfoId: 104,
      draftTourInfoStatus: 2, auditTourInfoStatus: 1, auditStatus: { key: "N", value: "未提交" },
      hotelResourceTourInfoId: 201, unrelatedSecret: "must-not-return",
    }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = (body) => ({
    ResponseStatus: { Ack: "Success" },
    tourInfo: { tourDailyDescriptions: [{ tourDailyInfos: [{
      description: `版本 ${body.tourInfoId} 的广济桥说明`,
      activeType: { key: 25, name: "集合" },
      tourDailyPackageGatherList: [{ airports: [{ code: "SWA", name: "揭阳潮汕机场" }] }],
      tourDailyPois: [{ poi: { poiId: 85862, poiName: "广济桥" }, suffixName: { key: 2, name: "外观" }, token: "must-not-return" }],
    }, { activeType: { key: 1, name: "酒店" }, tourDailyHotels: [{ hotel: { grade: { key: -38, name: "当地5钻酒店" } } }], privatePayload: "must-not-return" }] }], cookie: "must-not-return" },
  });
  const result = await readItineraryDraftDiagnostic(makeFakePage() as any, "79189107");
  assert.deepEqual(result.versions.map((item) => [item.version, item.tourInfoId]), [
    ["formal", 101], ["draft", 102], ["audit", 103], ["preview", 104],
  ]);
  assert.deepEqual(result.versions[1]?.poi85862, {
    suffixName: { key: 2, name: "外观" }, description: "版本 102 的广济桥说明",
  });
  assert.deepEqual(result.versions[1]?.pickup, { code: "SWA", name: "揭阳潮汕机场" });
  assert.deepEqual(result.versions[1]?.hotelGrades, [{ key: "-38", name: "当地5钻酒店" }]);
  assert.equal(result.versions[0]?.linkedTourInfoIds.hotelResourceTourInfoId, 201);
  assert.deepEqual(result.versions[0]?.statuses, {
    draftTourInfoStatus: 2, auditTourInfoStatus: 1, auditStatus: { key: "N", value: "未提交" },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret|privatePayload|cookie|token/i);
});

test("diagnostic does not infer a missing version or an unknown POI suffix", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfos: [{ tourInfoId: 101, draftTourInfoId: null, auditTourInfoId: 0 }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
  });
  const result = await readItineraryDraftDiagnostic(makeFakePage() as any, "79189107");
  assert.deepEqual(result.versions, [{
    version: "formal", tourInfoId: 101, linkedTourInfoIds: { tourInfoId: 101, draftTourInfoId: null, auditTourInfoId: 0 },
    statuses: { draftTourInfoStatus: null, auditTourInfoStatus: null, auditStatus: null }, detail: "available",
    pickup: { code: null, name: null }, hotelGrades: [], poi85862: null,
  }]);
});

test("diagnostic labels an accepted but structurally missing detail as not available", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfos: [{ tourInfoId: 101 }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({ ResponseStatus: { Ack: "Success" } });
  const result = await readItineraryDraftDiagnostic(makeFakePage() as any, "79189107");
  assert.equal(result.versions[0]?.detail, "notAvailable");
  assert.equal(result.versions[0]?.pickup, null);
  assert.deepEqual(result.versions[0]?.hotelGrades, []);
  assert.equal(result.versions[0]?.poi85862, null);
});
