import assert from "node:assert/strict";
import test from "node:test";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { createCreationRecoveryTools, readCreationVariant } from "../../src/main/agent/integration-creation-recovery-tools.js";
import {
  clearRouteHandlers, installFetchStub, makeFakePage, routeHandlers, uninstallFetchStub,
} from "../automation/itinerary-api.test-helpers.js";

test.beforeEach(() => { clearRouteHandlers(); installFetchStub(); });
test.afterEach(() => clearRouteHandlers());
test.after(() => uninstallFetchStub());

test("creation recovery accepts only an explicitly linked saved draft and keeps historical formal/audit IDs diagnostic", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" },
    tourInfos: [{
      tourInfoId: "417816553915138158",
      draftTourInfoId: "417899634191761447",
      auditTourInfoId: "417816553915138158",
      draftTourInfoStatus: 1,
      auditTourInfoStatus: 2,
      auditStatus: { key: "A", value: "审核通过" },
    }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
  });
  const actual = await readCreationVariant(makeFakePage() as any, "79189107");
  assert.equal(actual.variant, "draft");
  assert.equal(actual.unsubmittedDraftVerified, true);
  assert.deepEqual(actual.ids, {
    formal: "417816553915138158",
    draft: "417899634191761447",
    audit: "417816553915138158",
  });
});

test("creation recovery does not infer a draft from formal/audit status", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" },
    tourInfos: [{ tourInfoId: "417816553915138158", auditTourInfoId: "417816553915138158", auditTourInfoStatus: 2 }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
  });
  const actual = await readCreationVariant(makeFakePage() as any, "79189107");
  assert.equal(actual.variant, "unknown");
  assert.equal(actual.unsubmittedDraftVerified, false);
  assert.equal(actual.ids.draft, undefined);
});

for (const [name, relation] of [
  ["formal", { tourInfoId: "417899634191761447" }],
  ["audit", { auditTourInfoId: "417899634191761447" }],
  ["preview", { previewTourInfoId: "417899634191761447" }],
] as const) {
  test(`creation recovery rejects a draft ID reused by ${name}`, async () => {
    routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
      ResponseStatus: { Ack: "Success" },
      tourInfos: [{
        tourInfoId: "417816553915138158",
        draftTourInfoId: "417899634191761447",
        auditTourInfoId: "417816553915138158",
        previewTourInfoId: "417815590194610231",
        draftTourInfoStatus: 1,
        ...relation,
      }],
    });
    routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
      ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
    });
    const actual = await readCreationVariant(makeFakePage() as any, "79189107");
    assert.equal(actual.variant, "unknown");
    assert.equal(actual.unsubmittedDraftVerified, false);
  });
}

for (const draftTourInfoId of [0, "", "not-a-version-id"] as const) {
  test(`creation recovery rejects invalid draft ID ${JSON.stringify(draftTourInfoId)}`, async () => {
    routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
      ResponseStatus: { Ack: "Success" },
      tourInfos: [{
        tourInfoId: "417816553915138158",
        draftTourInfoId,
        auditTourInfoId: "417816553915138158",
        previewTourInfoId: "417815590194610231",
        draftTourInfoStatus: 1,
      }],
    });
    routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
      ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
    });
    const actual = await readCreationVariant(makeFakePage() as any, "79189107");
    assert.equal(actual.variant, "unknown");
    assert.equal(actual.unsubmittedDraftVerified, false);
  });
}

test("creation recovery permits first creation with only independent draft and preview IDs", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" },
    tourInfos: [{
      draftTourInfoId: "417899634191761447",
      previewTourInfoId: "417815590194610231",
      draftTourInfoStatus: 1,
    }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
  });
  const actual = await readCreationVariant(makeFakePage() as any, "79189107");
  assert.equal(actual.variant, "draft");
  assert.equal(actual.unsubmittedDraftVerified, true);
});

test("production recovery factory completes its coordinator-held account check without re-entering the page queue", async () => {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" },
    tourInfos: [{ tourInfoId: "417816553915138158", auditTourInfoId: "417816553915138158", auditTourInfoStatus: 2 }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
  });
  const product = {
    id: "local-product", productId: "79189107", vbkAccount: "vbk_account", productJsonVersion: 7,
    product: {
      basicInfo: { meetingCity: "汕头", destinationCity: "汕头", days: 2, nights: 1 }, itinerary: [],
      operations: { trafficLine: {
        enabled: true, variants: ["flightRoundTrip"],
        availability: {
          availableVariants: ["flightRoundTrip"],
          endpointPlan: {
            arrivalCity: "汕头", departureCity: "汕头", resolvedAt: "2026-10-01T00:00:00.000Z",
            flight: { arrival: { code: "SWA", name: "揭阳潮汕机场" }, departure: { code: "SWA", name: "揭阳潮汕机场" } },
          },
          unavailableVariants: {},
        },
      } },
    },
  } as any;
  const coordinator = new ProductWorkflowCoordinator();
  const [tool] = createCreationRecoveryTools({
    db: { getProduct: () => product },
    browser: {
      status: async () => ({ loggedIn: true, loginAccount: "vbk_account" }),
      page: async () => makeFakePage(),
    },
    productWorkflows: coordinator,
  } as any, () => product);
  const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("recovery factory page queue timed out")), 100));
  await assert.rejects(
    Promise.race([tool!.execute({}, { localProductId: "local-product", accountKey: "", productVersion: "" }), timeout]),
    /未提审草稿 variant/,
  );
  assert.equal(coordinator.activeWorkflow("local-product"), undefined);
  assert.equal(await coordinator.runVbkPageExclusive(async () => "released"), "released");
});
