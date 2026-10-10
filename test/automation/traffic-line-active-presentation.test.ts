import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrafficLineApi } from "../../src/main/automation/ctrip/traffic-line/main.js";

test("an active child inherits repaired parent presentation before entering final readback", async () => {
  const calls: string[] = [];
  let childText = "old";
  const response = (payload: unknown) => ({ status: 200, durationMs: 1, ctx: {}, payload });
  const page = {
    vbkSessionGetText: async () => ({ status: 200,
      text: '<script>window.__INITIAL_STATE__ = {"childList":[{"subProductId":"2","lineDescription":"飞机往返","isActiveInPackage":"T"}]};</script>',
    }),
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request.endpoint); calls.push(endpoint);
      if (endpoint.endsWith("getdescriptionInfo")) return response({ ResponseStatus: { Ack: "Success" }, info: {
        productDesc: { productDesc: request.body.productId === "1" ? "current" : childText }, pmRcmdItems: [],
      } });
      if (endpoint.endsWith("createProductDraft")) {
        assert.equal(request.body.productId, "2"); assert.equal(request.body.module, "desc");
        return response({ ResponseStatus: { Ack: "Success" } });
      }
      if (endpoint.endsWith("savedescriptioninfo")) {
        childText = request.body.dto.productDesc.productDesc;
        return response({ ResponseStatus: { Ack: "Success" }, success: true });
      }
      throw new Error("readback probe unavailable");
    },
  };
  const checkpoints: any[] = [];
  const result = await ensureTrafficLineApi(page as never, "1", { enabled: true, variants: ["flightRoundTrip"] }, {
    itinerary: [{}], endpointPlan: { arrivalCity: "北京", departureCity: "北京", resolvedAt: "2026-10-08",
      flight: { arrival: { code: "PEK", name: "首都国际机场" }, departure: { code: "PEK", name: "首都国际机场" } } },
    stableReadbackIntervalMs: 0, stableReadbackSamples: 1, sleep: async () => {},
    onChildProgress: progress => checkpoints.push(progress),
  });
  assert.equal(childText, "current");
  assert.equal(calls.filter(url => url.endsWith("savedescriptioninfo")).length, 1);
  assert.equal(calls.some(url => /saveLineInfo|submitSegment|saveSegment/.test(url)), false);
  assert.ok(checkpoints.some(item => item.completedStages.includes("presentationCopied")));
  assert.deepEqual(result.children, [], "an unavailable final probe must not create completion proof");
});
