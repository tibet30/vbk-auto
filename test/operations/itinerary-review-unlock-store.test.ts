import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import type { ItineraryReviewUnlockState } from "../../src/shared/itinerary-review-unlock.js";

test("itinerary review state persists across database restart and replaces atomically", context => {
  const root = mkdtempSync(join(tmpdir(), "vbk-review-unlock-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const dispatched: ItineraryReviewUnlockState = {
    localProductId: "local", status: "dispatched", attemptId: "attempt", productId: "100",
    accountKey: "vbk-a", tourInfoId: "420000000000000001", beforeDigest: "before",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
  let db = new VbkDatabase(root);
  db.saveItineraryReviewUnlockState(dispatched);
  db.close();

  db = new VbkDatabase(root);
  assert.deepEqual(db.getItineraryReviewUnlockState("local"), dispatched);
  const uncertain = { ...dispatched, status: "uncertain" as const, message: "timeout",
    digestMismatch: {
      step: "审核校验", beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64),
      paths: ["$.tourDailyDescriptions[0].tourDailyInfos[0].description"],
    },
    updatedAt: "2026-10-14T00:01:00.000Z" };
  db.saveItineraryReviewUnlockState(uncertain);
  assert.deepEqual(db.getItineraryReviewUnlockState("local"), uncertain);
  assert.equal(db.getItineraryReviewUnlockState("missing"), undefined);
  db.close();
});
