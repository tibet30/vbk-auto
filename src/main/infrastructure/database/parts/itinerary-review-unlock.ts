import type Database from "better-sqlite3";
import type { ItineraryReviewUnlockState } from "../../../../shared/itinerary-review-unlock.js";

export function getItineraryReviewUnlockState(
  db: Database.Database,
  localProductId: string,
): ItineraryReviewUnlockState | undefined {
  const row = db.prepare(
    "SELECT state_json FROM itinerary_review_unlock WHERE local_product_id=?",
  ).get(localProductId) as { state_json: string } | undefined;
  return row ? JSON.parse(row.state_json) as ItineraryReviewUnlockState : undefined;
}

export function saveItineraryReviewUnlockState(
  db: Database.Database,
  state: ItineraryReviewUnlockState,
): void {
  if (!state.localProductId || !state.updatedAt) {
    throw new Error("行程审核解锁状态缺少产品身份或更新时间");
  }
  db.prepare(`INSERT INTO itinerary_review_unlock(local_product_id,state_json,updated_at)
    VALUES(?,?,?) ON CONFLICT(local_product_id) DO UPDATE SET
      state_json=excluded.state_json,updated_at=excluded.updated_at`)
    .run(state.localProductId, JSON.stringify(state), state.updatedAt);
}
