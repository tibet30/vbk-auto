import assert from "node:assert/strict";
import test from "node:test";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";

test("draft diagnostic tools resolve the lazy browser only when executed", async () => {
  const product = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  product.productId = "79189107";
  product.vbkAccount = "vbk_bound";
  let browser: any;
  const tools = createAgentBusinessTools({
    db: { getProduct: () => product, getAgentSnapshot: () => undefined, saveAutomation: () => undefined } as any,
    get browser() { return browser; },
    automation: {} as any,
    productWorkflows: {
      runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
      runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
    } as any,
    productMutations: {} as any,
    generateStage: async () => ({ reply: "ok", modules: [] }),
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }),
    emitProduct: () => undefined,
  });
  const capture = tools.find((tool) => tool.name === "capture_itinerary_draft_save");
  assert.ok(capture, "factory must be constructible before the Electron browser exists");
  let stopped = 0;
  let captured: any = null;
  browser = {
    status: async () => ({ loggedIn: true, loginAccount: "vbk_bound" }),
    armItineraryDraftCapture: async (productId: string) => ({ armedAt: "2026-10-01T00:00:00.000Z", productId }),
    readItineraryDraftCapture: () => captured,
    stopItineraryDraftCapture: () => { stopped += 1; },
  };
  const result = await capture.execute({ action: "arm" }, { localProductId: product.id, accountKey: "vbk_bound", productVersion: "v" });
  assert.deepEqual(JSON.parse(result.content), { armedAt: "2026-10-01T00:00:00.000Z", productId: "79189107" });

  captured = {
    armedAt: "2026-10-01T00:00:00.000Z", productId: "79189107", complete: true, missingSteps: [],
    payload: {
      saveType: 7, tourInfoId: "417816553915138158", draftTourInfoId: "417899634191761447",
      auditTourInfoId: "417816553915138158", previewTourInfoId: "417815590194610231",
      auditTourInfoStatus: 2, draftTourInfoStatus: 1, auditStatusKey: "A", auditStatusValue: "审核通过",
      locations: {}, versionValues: { tourInfoId: [{ location: "tourDaily", value: "417816553915138158" }] },
      protocolValues: {}, tourDailyType: "string", requestHeaderPresent: false, piCategoryId: null,
    },
    exchanges: [],
  };
  const read = await capture.execute({ action: "read" }, { localProductId: product.id, accountKey: "vbk_bound", productVersion: "v" });
  const observed = JSON.parse(read.content);
  assert.equal(stopped, 1, "read must dispose the observer and its timeout");
  assert.deepEqual(observed.exchanges, []);

  const versionValues = Object.fromEntries([
    "tourInfoId", "draftTourInfoId", "auditTourInfoId", "previewTourInfoId", "auditTourInfoStatus", "draftTourInfoStatus",
  ].map((field) => [field, Array.from({ length: 5 }, () => ({ location: "tourDaily", value: "417899634191761447" }))]));
  const protocolValues = {
    isModify: Array.from({ length: 5 }, () => ({ location: "tourDaily", value: true })),
    isNew: Array.from({ length: 5 }, () => ({ location: "tourDaily", value: false })),
    fromTourInfoId: Array.from({ length: 5 }, () => ({ location: "tourDaily", value: "417816553915138158" })),
    firstGatherAirport: Array.from({ length: 5 }, () => ({ location: "tourDaily", code: "SWA", name: "揭阳潮汕机场" })),
  };
  const densePayload = { saveType: 7, versionValues, protocolValues };
  captured = {
    ...captured,
    exchanges: Array.from({ length: 12 }, (_, index) => ({
      step: "checkTourDaily", source: "native", observedAt: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      request: densePayload, response: densePayload,
    })),
  };
  const bounded = await capture.execute({ action: "read" }, { localProductId: product.id, accountKey: "vbk_bound", productVersion: "v" });
  const compact = JSON.parse(bounded.content);
  assert.ok(bounded.content.length <= 10_000, "capture output must fit the agent tool content limit");
  assert.ok(compact.omittedExchangeCount > 0);
});
