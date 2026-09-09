import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAgentShell } from "../../src/main/agent/integration-reconcile.js";

function hotelSnapshot(message: string) {
  return {
    events: [
      { type: "tool_call", data: { toolCallId: "call-hotel", arguments: { phase: "hotelResource" } } },
      { type: "tool_result", data: { toolCallId: "call-hotel" }, content: message },
    ],
  } as any;
}

function product() {
  return {
    productId: "78090372",
    product: { itinerary: [{ hotelCandidates: [{ hotelId: 130061572 }] }, { hotel: "无", hotelCandidates: [] }] },
  } as any;
}

test("酒店资源回读明确无任何酒店时才允许定向重试", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as any).document;
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ResponseStatus: { Ack: "Success" },
    draftProductSegments: { segments: [{ segmentBase: { stayNights: 1 }, hotel: { segmentRooms: [] } }] },
  }))) as typeof fetch;
  try {
    const result = await reconcileAgentShell(product(), hotelSnapshot("酒店资源最终接口回读不一致"), "call-hotel", {
      evaluate: async (fn: any, arg: any) => fn(arg),
    } as any);
    assert.equal(result.retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = originalDocument;
  }
});

test("酒店资源已有部分指定酒店时保持停止，不覆盖现场", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as any).document;
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ResponseStatus: { Ack: "Success" },
    draftProductSegments: { segments: [{ segmentBase: { stayNights: 1 }, hotel: { segmentRooms: [{ masterHotelID: 130061572 }] } }] },
  }))) as typeof fetch;
  try {
    const result = await reconcileAgentShell(product(), hotelSnapshot("酒店资源最终接口回读不一致"), "call-hotel", {
      evaluate: async (fn: any, arg: any) => fn(arg),
    } as any);
    assert.equal(result.retryable, undefined);
    assert.match(result.message, /已保存指定酒店 1 家/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = originalDocument;
  }
});

test("交通子产品有明确失败节点时只允许定向重试，不把父阶段标记完成", async () => {
  const p = product();
  p.automation = { trafficLine: { children: [{
    variant: "flightRoundTrip",
    lineDescription: "飞机往返",
    childProductId: "78126066",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied", "resourcesSaved", "itinerarySaved"],
    verified: false,
    failedStage: "clausesSaved",
    failureReason: "候选 0 项",
  }] } };
  const snapshot = { events: [{ type: "tool_call", data: { toolCallId: "call-traffic", arguments: { phase: "trafficLine" } } }] } as any;
  const state = { childList: [{ subProductId: "78126066", lineDescription: "飞机往返", isActiveInPackage: false }] };
  const result = await reconcileAgentShell(p, snapshot, "call-traffic", {
    vbkSessionGetText: async () => ({ status: 200, text: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` }),
  } as any);
  assert.equal(result.reconciled, false);
  assert.equal(result.retryable, true);
  assert.match(result.message, /clausesSaved.*定向重试/);
});
