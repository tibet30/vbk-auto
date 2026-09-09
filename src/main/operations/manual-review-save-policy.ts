import type { ProductDetail } from "../../shared/contracts.js";

export function manualReviewSavePolicy(status: ProductDetail["status"]): {
  requireCompleteProduct: boolean;
  nextStatus: ProductDetail["status"];
} {
  // POI/cover review can be the action that unblocks a planning draft. Requiring
  // unrelated planning modules to already validate would make that action
  // impossible, and incorrectly promote the draft to the review stage.
  return status === "planning"
    ? { requireCompleteProduct: false, nextStatus: "planning" }
    : { requireCompleteProduct: true, nextStatus: "review" };
}
