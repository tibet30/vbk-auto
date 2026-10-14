import { createHash } from "node:crypto";
import type { ProductDetail } from "../../shared/contracts.js";
import type {
  ItineraryReviewStepReceipt,
  ItineraryReviewUnlockPlan,
  ItineraryReviewUnlockReceipt,
} from "../../shared/itinerary-review-unlock.js";
import type { VbkSessionRequestBrowser } from "../infrastructure/vbk-session-request.js";
import { isItineraryReviewCompletedMenus } from "../automation/ctrip/product-menu-readback.js";

export type ItineraryReviewEvidence = {
  productId: string;
  tourInfoId: string;
  contentDigest: string;
  relation: Record<string, unknown>;
  maxStep: number;
  fullyUnlocked: boolean;
  menus: Array<{ key: string; title: string; enabled: "T" | "F" }>;
};

export type ItineraryReviewReservation = {
  plan: ItineraryReviewUnlockPlan;
  fingerprint: string;
  relationFingerprint: string;
  expires: number;
};

export interface ItineraryReviewProtocol {
  read(page: VbkSessionRequestBrowser, productId: string): Promise<ItineraryReviewEvidence>;
  submit(page: VbkSessionRequestBrowser, evidence: ItineraryReviewEvidence, options: {
    assertCurrent?: () => void;
    onStep?: (step: ItineraryReviewStepReceipt) => void;
  }): Promise<void>;
  verify(
    page: VbkSessionRequestBrowser,
    productId: string,
    expectedDigest?: string,
    product?: Record<string, unknown>,
  ): Promise<ItineraryReviewUnlockReceipt>;
}

export const reviewMenuProgressVerified = (evidence: ItineraryReviewEvidence) =>
  isItineraryReviewCompletedMenus(evidence);

export const isReviewDraftMenuBoundary = (evidence: ItineraryReviewEvidence) => {
  const core = evidence.menus.slice(0, 10);
  return evidence.maxStep === -60 && core.length === 10
    && core.slice(0, 4).every(menu => menu.enabled === "T")
    && core.slice(4).every(menu => menu.enabled === "F")
    && evidence.menus.slice(10).every(menu => menu.enabled === "T");
};

export const reviewProductFingerprint = (product: ProductDetail) => JSON.stringify([
  product.id, product.productId, product.vbkAccount, product.productJsonVersion, product.product,
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export const reviewRelationFingerprint = (relation: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(canonical(relation))).digest("hex");

export function assertMatchingReviewEvidence(current: ItineraryReviewEvidence, expected: ItineraryReviewEvidence) {
  const menus = (value: ItineraryReviewEvidence) => JSON.stringify(
    value.menus.map(menu => [menu.key, menu.title, menu.enabled]),
  );
  if (current.productId !== expected.productId || current.tourInfoId !== expected.tourInfoId
    || current.contentDigest !== expected.contentDigest || current.maxStep !== expected.maxStep
    || menus(current) !== menus(expected)
    || reviewRelationFingerprint(current.relation) !== reviewRelationFingerprint(expected.relation)) {
    throw new Error("远端行程、菜单或关联身份在核验期间发生变化，请重新确认");
  }
}

export function assertPlannedReviewEvidence(
  planned: { tourInfoId: string; contentDigest: string }, evidence: ItineraryReviewEvidence,
) {
  if (planned.tourInfoId !== evidence.tourInfoId || planned.contentDigest !== evidence.contentDigest) {
    throw new Error("本地确认方案与当前远端行程版本不一致");
  }
}
