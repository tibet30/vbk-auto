import type { ProductDetail } from "../../shared/contracts.js";
import { isResearchTaskSatisfiedByProduct } from "../../shared/research-task-satisfaction.js";
import { isCoverResearchTaskSatisfiedByProduct } from "../minimax/minimax.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

type RefreshDb = Pick<VbkDatabase, "getProduct" | "markResearchTasksSatisfied">;

export interface RefreshedResearchIssues {
  updated: number;
  taskIds: string[];
}

export function refreshSatisfiedResearchTasks(db: RefreshDb, localProductId: string): RefreshedResearchIssues {
  const product = db.getProduct(localProductId);
  if (!product) {
    throw new Error("产品不存在。");
  }
  const satisfiedIds = satisfiedResearchTaskIds(product);
  return db.markResearchTasksSatisfied(localProductId, satisfiedIds);
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
