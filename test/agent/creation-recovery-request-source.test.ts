import assert from "node:assert/strict";
import test from "node:test";
import { readCreationRecoveryPreflight, readCreationRecoveryTrafficChild } from "../../src/main/agent/integration-creation-recovery-tools.js";

test("native recovery uses the target product source even while another product is visible", async () => {
  let source: string | undefined;
  const page = {
    url: () => "https://vbooking.ctrip.com/ivbk/vendor/packageManage?productId=79251083",
    goto: () => { throw new Error("recovery must not navigate"); },
    async withRequestSource(url: string, read: () => Promise<unknown>) {
      source = url;
      try { return await read(); } finally { source = undefined; }
    },
  };
  const product = {};
  const result = await readCreationRecoveryPreflight(page, product, "79251201", { itineraryTourInfoId: "418454618211680279" }, async (actualPage, actualProduct, id, options) => {
    assert.equal(actualPage, page);
    assert.equal(actualProduct, product);
    assert.equal(source, "https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=79251201&from=vbk");
    assert.equal(id, "79251201");
    assert.equal(options?.itineraryTourInfoId, "418454618211680279");
    return { verified: true } as any;
  });
  assert.deepEqual(result, { verified: true });
  assert.equal(source, undefined);
});

test("standalone recovery preserves the verified itinerary ID without requiring native context", async () => {
  const options = { itineraryTourInfoId: "418454618211680279" };
  const result = await readCreationRecoveryPreflight({}, {}, "79251201", options, async (_page, _product, id, actualOptions) => ({ id, actualOptions }) as any);
  assert.deepEqual(result, { id: "79251201", actualOptions: options });
});

test("traffic recovery scopes its reads to the child resource editor and restores source on failure", async () => {
  let source: string | undefined;
  const page = {
    async withRequestSource(url: string, read: () => Promise<unknown>) {
      source = url;
      try { return await read(); } finally { source = undefined; }
    },
  };
  const endpoints = {} as any;
  await assert.rejects(readCreationRecoveryTrafficChild(page, "79189107", "79194665", "flightRoundTrip", endpoints,
    async (actualPage, parentId, childId, variant, actualEndpoints) => {
      assert.equal(actualPage, page);
      assert.equal(source, "https://vbooking.ctrip.com/product/input/newResourceRule?productid=79194665&from=vbk");
      assert.equal(parentId, "79189107");
      assert.equal(childId, "79194665");
      assert.equal(variant, "flightRoundTrip");
      assert.equal(actualEndpoints, endpoints);
      throw new Error("real resource failure");
    }), /real resource failure/);
  assert.equal(source, undefined);
});
