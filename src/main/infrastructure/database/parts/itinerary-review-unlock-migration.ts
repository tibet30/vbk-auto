import type { Migration } from "./migrations.js";

/** Durable state for the separately-authorized itinerary review/unlock command. */
export const itineraryReviewUnlockMigration: Migration = {
  id: "0018_itinerary_review_unlock",
  statements: [
    `CREATE TABLE IF NOT EXISTS itinerary_review_unlock (
      local_product_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_itinerary_review_unlock_updated_at
      ON itinerary_review_unlock(updated_at DESC)`,
  ],
};
