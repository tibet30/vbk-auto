import assert from "node:assert/strict";
import test from "node:test";
import { createItineraryDraftTools } from "../../src/main/agent/integration-itinerary-draft-tools.js";
import { clearRouteHandlers, installFetchStub, makeFakePage, routeHandlers, uninstallFetchStub } from "../automation/itinerary-api.test-helpers.js";

test.beforeEach(() => { clearRouteHandlers(); installFetchStub(); });
test.afterEach(() => clearRouteHandlers());
test.after(() => uninstallFetchStub());

function tool(children: unknown[], account = "vbk_671205", capture = false) {
  const page = makeFakePage() as any;
  page.vbkSessionGetText = async ({ endpoint }: { endpoint: string }) => {
    assert.match(endpoint, /trafficLineEdit\?productid=79251201/);
    return { status: 200, text: `window.__INITIAL_STATE__=${JSON.stringify({ childList: children })};` };
  };
  return createItineraryDraftTools({
    browserFor: () => ({ page: async () => page, status: async () => ({ loggedIn: true, loginAccount: account }), armItineraryDraftCapture: async (productId: string) => ({ productId }) }) as any,
    get: () => ({ productId: "79251201", vbkAccount: "vbk_671205" }) as any,
    withPage: async (read) => read(),
  })[capture ? 0 : 1]!;
}
const ctx = { localProductId: "local", accountKey: "vbk_671205", productVersion: "1" };

test("child diagnosis reads only the unique remotely linked child and transport type projection", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = (body) => {
    assert.equal(body.productId, 79251262);
    return { ResponseStatus: { Ack: "Success" }, tourInfos: [{ tourInfoId: "418455573494431756" }] };
  };
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [{ tourDailyInfos: [
      { activeType: { key: 14 }, description: "must-not-return" }, { activeType: { key: 4 } },
    ] }] },
  });
  const result = await tool([{ subProductId: "79251262", lineDescription: "火车往返" }]).execute({ trafficVariant: "trainRoundTrip" }, ctx);
  const data = JSON.parse(result.content);
  assert.equal(data.productId, "79251262");
  assert.deepEqual(data.versions[0].transportTypes, [{ day: 1, keys: [14] }]);
  assert.doesNotMatch(result.content, /must-not-return/);
});

for (const children of [[], [{ subProductId: "79251262", lineDescription: "火车往返" }, { subProductId: "79251263", lineDescription: "火车往返" }]]) {
  test(`child diagnosis rejects nonunique relation count ${children.length}`, async () => {
    await assert.rejects(tool(children).execute({ trafficVariant: "trainRoundTrip" }, ctx), /唯一确认/);
  });
}
test("child diagnosis rejects a different logged in account before querying the relationship", async () => {
  await assert.rejects(tool([], "other-account").execute({ trafficVariant: "trainRoundTrip" }, ctx), /账号.*不一致/);
});


test("child capture is armed only for the uniquely linked variant", async () => {
  const result = await tool([{ subProductId: "79251262", lineDescription: "火车往返" }], "vbk_671205", true)
    .execute({ action: "arm", trafficVariant: "trainRoundTrip" }, ctx);
  assert.deepEqual(JSON.parse(result.content), { productId: "79251262" });
});

test("child capture rejects a missing relation before arming", async () => {
  await assert.rejects(tool([], "vbk_671205", true).execute({ action: "arm", trafficVariant: "trainRoundTrip" }, ctx), /唯一确认/);
});
