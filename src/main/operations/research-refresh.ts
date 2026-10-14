import type { ProductDetail } from "../../shared/contracts.js";
import { isResearchTaskSatisfiedByProduct } from "../../shared/research-task-satisfaction.js";
import { isCoverResearchTaskSatisfiedByProduct } from "../minimax/minimax.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

type RefreshDb = Pick<VbkDatabase,
  "getProduct" | "markResearchTasksSatisfiedByProduct" | "reopenAmbiguousAutoConfirmedPoiResearchTasks" | "reopenKindSupersededPoiResearchTasks"
>;

export interface RefreshedResearchIssues {
  /** Backward-compatible alias for `confirmed`; reopening alone is not a confirmation. */
  updated: number;
  taskIds: string[];
  confirmed: number;
  confirmedTaskIds: string[];
  reopened: number;
  reopenedTaskIds: string[];
}

export function refreshSatisfiedResearchTasks(db: RefreshDb, localProductId: string): RefreshedResearchIssues {
  const product = db.getProduct(localProductId);
  if (!product) {
    throw new Error("产品不存在。");
  }
  const kindReopened = db.reopenKindSupersededPoiResearchTasks(localProductId, product.product);
  const ambiguousReopened = db.reopenAmbiguousAutoConfirmedPoiResearchTasks(localProductId);
  const refreshedProduct = db.getProduct(localProductId);
  if (!refreshedProduct) throw new Error("产品不存在。");
  const confirmed = db.markResearchTasksSatisfiedByProduct(localProductId, refreshedProduct.product);
  const reopenedTaskIds = [...kindReopened.taskIds, ...ambiguousReopened.taskIds];
  return {
    updated: confirmed.updated,
    taskIds: confirmed.taskIds,
    confirmed: confirmed.updated,
    confirmedTaskIds: confirmed.taskIds,
    reopened: reopenedTaskIds.length,
    reopenedTaskIds,
  };
}

/** Reopening a stale local task must never create a cloud write by itself. */
export function shouldSyncConfirmedResearchTasks(result: Pick<RefreshedResearchIssues, "confirmed">): boolean {
  return result.confirmed > 0;
}

export function satisfiedResearchTaskIds(product: ProductDetail): string[] {
  return product.researchTasks
    .filter((task) =>
      task.state !== "confirmed" &&
      task.state !== "resolved" &&
      (isResearchTaskSatisfiedByProduct(task, product.product) ||
        isCoverResearchTaskSatisfiedByProduct(task, product.product)),
    )
    .map((task) => task.id);
}
