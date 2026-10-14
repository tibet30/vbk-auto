import type { ItineraryReviewUnlockReceipt } from "../../../../shared/itinerary-review-unlock.js";
import type { TrafficLinePage } from "../traffic-line/client.js";
import { verifyItineraryReviewUnlock } from "./unlock.js";

const DEFAULT_ATTEMPTS = 49;
const DEFAULT_INTERVAL_MS = 5_000;

type VerificationOptions = {
  attempts?: number;
  intervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  assertCurrent?: () => void | Promise<void>;
};

function isPendingReadback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /审核后未形成连续的套餐管理解锁边界|行程审核尚未通过远端回读/u.test(message);
}

/**
 * VBK accepts the review request before routeId, auditStatus and menu state become
 * visible together. Poll only those explicit pending states; identity, digest,
 * publication and child-product failures remain terminal on the first read.
 */
export async function verifyItineraryReviewUnlockEventually(
  page: TrafficLinePage,
  productId: string,
  expectedDigest?: string,
  product?: unknown,
  options: VerificationOptions = {},
): Promise<ItineraryReviewUnlockReceipt> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    await options.assertCurrent?.();
    try {
      return await verifyItineraryReviewUnlock(page, productId, expectedDigest, product);
    } catch (error) {
      if (attempt >= attempts || !isPendingReadback(error)) throw error;
      await wait(intervalMs);
    }
  }
}
