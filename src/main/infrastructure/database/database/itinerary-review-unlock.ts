import type Database from "better-sqlite3";
import type { ItineraryReviewUnlockState } from "../../../../shared/itinerary-review-unlock.js";
import {
  getItineraryReviewUnlockState,
  saveItineraryReviewUnlockState,
} from "../parts/itinerary-review-unlock.js";

export const itineraryReviewUnlockMethods = {
  getItineraryReviewUnlockState(this: { db: Database.Database }, id: string) {
    return getItineraryReviewUnlockState(this.db, id);
  },
  saveItineraryReviewUnlockState(this: { db: Database.Database }, state: ItineraryReviewUnlockState) {
    saveItineraryReviewUnlockState(this.db, state);
  },
} as const;
