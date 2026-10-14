import type { ProductDetail } from "../../shared/contracts.js";
import type { ItineraryReviewUnlockState } from "../../shared/itinerary-review-unlock.js";
import type { VbkSessionRequestBrowser } from "../infrastructure/vbk-session-request.js";
import type { ItineraryReviewProtocol } from "./itinerary-review-unlock-support.js";

export interface ItineraryReviewUnlockDependencies {
  getProduct(id: string): ProductDetail | null | undefined;
  accountKey(): string;
  assertIdle(id: string): void;
  withLocks<T>(id: string, work: () => Promise<T>): Promise<T>;
  getPage(productId: string): Promise<VbkSessionRequestBrowser>;
  stateStore: {
    get(id: string): ItineraryReviewUnlockState | undefined;
    save(state: ItineraryReviewUnlockState): void;
  };
  record(
    id: string,
    status: "running" | "succeeded" | "failed",
    message: string,
    payload: Record<string, unknown>,
  ): void;
  now?: () => number;
  /** Test seam; production wiring passes the three itinerary-review API functions. */
  protocol?: ItineraryReviewProtocol;
  preflight?: (
    page: VbkSessionRequestBrowser,
    product: Record<string, unknown>,
    productId: string,
    options: { itineraryTourInfoId: string },
  ) => Promise<unknown>;
  verifyPlan?: (
    page: VbkSessionRequestBrowser,
    product: Record<string, unknown>,
    productId: string,
    tourInfoId: string,
  ) => Promise<{ tourInfoId: string; days: number; contentDigest: string }>;
}
