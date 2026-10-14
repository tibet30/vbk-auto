import assert from "node:assert/strict";
import test from "node:test";
import { ItineraryReviewDigestMismatchError } from "../../src/main/automation/ctrip/itinerary-review/evidence.js";
import {
  uncertainItineraryReviewState,
  verifiedItineraryReviewState,
} from "../../src/main/operations/itinerary-review-unlock-state.js";
import type { ItineraryReviewUnlockState } from "../../src/shared/itinerary-review-unlock.js";

test("manual unlock state stores only the safe mismatch fields", () => {
  const mismatch = {
    step: "审核校验", beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64),
    paths: ["$.tourDailyDescriptions[0].tourDailyInfos[0].description"],
  };
  const error = new ItineraryReviewDigestMismatchError(mismatch) as Error & { digestMismatch: unknown };
  error.digestMismatch = { ...mismatch, tourDaily: "正文不得保存" };
  const state: ItineraryReviewUnlockState = {
    localProductId: "local", status: "dispatched", attemptId: "attempt", productId: "100",
    accountKey: "account", tourInfoId: "tour", beforeDigest: mismatch.beforeDigest, updatedAt: "before",
  };
  const result = uncertainItineraryReviewState(state, error, "after");
  assert.equal(result.status, "uncertain");
  assert.deepEqual(result.digestMismatch, mismatch);
  assert.equal(JSON.stringify(result).includes("正文不得保存"), false);
});

test("readonly recovery preserves the exact uncertain workflow binding", () => {
  const previous: ItineraryReviewUnlockState = {
    localProductId: "local", status: "uncertain", attemptId: "attempt",
    approvalId: "approval", agentRunId: "run", productId: "100", accountKey: "account",
    tourInfoId: "tour", beforeDigest: "a".repeat(64), requestSteps: [{
      step: "saveProduct3", endpoint: "/save", saveType: 3, ack: "Success", at: "now",
    }], updatedAt: "before",
  };
  const receipt: any = {
    verified: true, productId: "100", tourInfoId: "tour", beforeDigest: "a".repeat(64),
    afterDigest: "a".repeat(64), contentDigest: "a".repeat(64), routeId: 7, maxStep: 10,
    menus: [], publication: { active: "F", isonline: "F", releaseActive: "F" },
    trafficChildren: 0, checkedAt: "now", tabs: [], requestSteps: previous.requestSteps,
  };
  const result = verifiedItineraryReviewState(
    { id: "local", productId: "100", vbkAccount: "account" } as any,
    previous, "attempt", receipt, "after",
  );
  assert.equal(result.approvalId, "approval");
  assert.equal(result.agentRunId, "run");
});
