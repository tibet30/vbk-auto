import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrainReplacementEndpoints } from "../../src/main/automation/ctrip/traffic-line/endpoints.js";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";

test("replacing an unavailable train station excludes rejected stations without re-querying airports", async () => {
  const requests: string[] = [];
  const page = {
    nativeOnly: true,
    evaluate: async () => { throw new Error("native session expected"); },
    vbkSessionFetch: async (request: { endpoint: string }) => {
      requests.push(request.endpoint);
      assert.match(request.endpoint, /suggestTrainStation$/);
      return { status: 200, durationMs: 1, ctx: EMPTY_VBK_SESSION_CONTEXT,
        payload: { ResponseStatus: { Ack: "Success" }, trainStations: [
          { locationCode: "CN001ICW", stationName: "成都东", geoId: 28, stationNo: 28 },
          { locationCode: "CN001CDW", stationName: "成都", geoId: 28, stationNo: 28 },
        ] } };
    },
  };
  const plan = await resolveTrainReplacementEndpoints(page, [{}], new Date("2026-10-08"), undefined,
    { basicInfo: { destinationCity: "成都" } }, { excludedTrainCodes: ["CN001ICW"] });
  assert.equal(plan.train?.arrival.code, "CN001CDW");
  assert.equal(plan.train?.departure.code, "CN001CDW");
  assert.equal(plan.flight, undefined);
  assert.equal(requests.length, 1);
});
