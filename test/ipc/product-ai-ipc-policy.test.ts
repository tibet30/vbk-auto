import assert from "node:assert/strict";
import test from "node:test";
import { manualReviewSavePolicy } from "../../src/main/operations/manual-review-save-policy.js";

test("planning draft permits a local review-field save without premature lifecycle promotion", () => {
  assert.deepEqual(manualReviewSavePolicy("planning"), {
    requireCompleteProduct: false,
    nextStatus: "planning",
  });
});

test("review-field saves on non-planning products retain complete-product validation", () => {
  assert.deepEqual(manualReviewSavePolicy("review"), {
    requireCompleteProduct: true,
    nextStatus: "review",
  });
});
