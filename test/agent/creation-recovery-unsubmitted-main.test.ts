import assert from "node:assert/strict";
import test from "node:test";
import { readCreationVariant } from "../../src/main/agent/integration-creation-recovery-tools.js";
import { clearRouteHandlers, installFetchStub, makeFakePage, routeHandlers, uninstallFetchStub } from "../automation/itinerary-api.test-helpers.js";

test.beforeEach(() => { clearRouteHandlers(); installFetchStub(); });
test.afterEach(() => clearRouteHandlers());
test.after(() => uninstallFetchStub());

const observed = {
  tourInfoId: "418454618211680279", auditTourInfoId: "418454618211680279",
  previewTourInfoId: "418455573494431756", draftTourInfoStatus: 1,
  auditTourInfoStatus: 1, auditStatus: { key: "N", value: "未提交" },
};

async function read(overrides: Record<string, unknown> = {}) {
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfos: [{ ...observed, ...overrides }],
  });
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [] },
  });
  return readCreationVariant(makeFakePage() as any, "79251201");
}

test("observed first-created unsubmitted main relation is a recovery draft with explicit provenance", async () => {
  const actual = await read();
  assert.equal(actual.variant, "draft");
  assert.equal(actual.unsubmittedDraftVerified, true);
  assert.equal(actual.draftSource, "unsubmitted-main");
  assert.equal(actual.ids.draft, observed.tourInfoId);
  assert.equal(actual.ids.formal, observed.tourInfoId);
});

for (const [name, overrides] of Object.entries({
  approved: { auditStatus: { key: "A", value: "审核通过" } },
  submitted: { auditTourInfoStatus: 2 },
  unknown: { auditStatus: null },
  ambiguousAudit: { auditTourInfoId: "418455573494431756" },
  noPreview: { previewTourInfoId: 0 },
  aliasedPreview: { previewTourInfoId: observed.tourInfoId },
  explicitAliasedDraft: { draftTourInfoId: observed.tourInfoId },
  unsaved: { draftTourInfoStatus: 2 },
})) {
  test(`unsubmitted main recovery rejects ${name}`, async () => {
    const actual = await read(overrides);
    assert.equal(actual.variant, "unknown");
    assert.equal(actual.unsubmittedDraftVerified, false);
  });
}
