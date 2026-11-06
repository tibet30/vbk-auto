import assert from "node:assert/strict";
import test from "node:test";
import { restoreExplicitOperatorDeletion } from "../../src/main/agent/integration-setup.js";

/** 成都 48bff2f7：第4天「九寨沟风景区」被删除后，运营明确要求第四天必须有九寨沟景区。 */
function product(): Record<string, unknown> {
  return { manualReview: { itinerarySpotRemovals: [{ day: 4, name: "九寨沟风景区", removedAt: "2026-11-06T05:16:49.993Z",
    poiName: "九寨沟风景区", poiId: 89895, spotId: "sp_66fa1677f2f3" }] } };
}
const receipts = (value: Record<string, unknown>) => (value.manualReview as Record<string, unknown>).itinerarySpotRemovals;

for (const content of [
  "第四天要有九寨沟的景区。",
  "第四天要有九寨沟的景区，这个情况下一般都要设置POI。",
  "第四天我不希望延后录入，我就需要第四天必须要有九寨沟的景点POI录进去。",
]) {
  test(`明确要求当天必须有该景点会撤销删除凭证：${content}`, () => {
    const value = product();
    assert.equal(restoreExplicitOperatorDeletion(value, content), true);
    assert.deepEqual(receipts(value), []);
  });
}

for (const content of ["第四天不需要九寨沟了", "第四天不要九寨沟的景区", "第三天要有九寨沟的景区", "九寨沟要有景区"]) {
  test(`否定、错日或未指明日次时保留删除凭证：${content}`, () => {
    const value = product();
    assert.equal(restoreExplicitOperatorDeletion(value, content), false);
    assert.equal((receipts(value) as unknown[]).length, 1);
  });
}
