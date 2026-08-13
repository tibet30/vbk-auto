/**
 * 「产品 JSON 写入」与「research task 字段匹配确认」原子化写入口。
 *
 * 该文件仅承担 `replaceProductAndSatisfyResearchTasks` 这一个原子写函数，
 * 把：
 *   - UPDATE products SET product_json=..., status=...
 *   - UPDATE research_tasks SET state='confirmed', status='succeeded' ...
 * 放在同一个 db.transaction()，并按 task label/type 严格匹配；不允许 blanket
 * 确认所有 queued task。
 *
 * 背景（真实回归，产品 3e6a4db5-…）：products:updateReviewField 旧实现只调
 * productMutations.replace（→ db.updateProduct），不同步动 research_tasks 表，
 * 导致 UI 乐观态 100% 与 products:readiness / 自动化 preflight 重新算出的
 * 92% 不一致，automation_runs basic 阶段被旧 task 阻断。本模块只服务于这个
 * 边界修复，与 AI / 自动化 / 规划路径无关——后者继续走 productMutations。
 */

import type Database from "better-sqlite3";
import type { ProductDetail, ProductSummary } from "../../../../shared/contracts.js";
import { getProduct, updateProduct } from "./products.js";
import { markResearchTasksSatisfiedByProduct } from "./research-tasks.js";

export interface ReplaceProductAndSatisfyResearchTasksOptions {
  status?: ProductSummary["status"];
  note?: string;
  source?: "vbk" | "web" | "user";
  /** evidence 标题；默认使用 options.note。 */
  researchEvidenceTitle?: string;
}

/**
 * 原子地「写产品 JSON + 按字段匹配确认 research task」。
 *
 * 复用 markResearchTasksSatisfiedByProduct 的严格匹配（按 task label/type
 * 逐条 predicate 判定；不 blanket 确认所有 queued 行；已 confirmed / resolved
 * 的 task 不会被覆盖）。
 */
export function replaceProductAndSatisfyResearchTasks(
  db: Database.Database,
  localProductId: string,
  product: Record<string, unknown>,
  options: ReplaceProductAndSatisfyResearchTasksOptions = {},
): { product: ProductDetail; confirmedTaskIds: string[] } {
  const tx = db.transaction(() => {
    updateProduct(db, localProductId, product, options.status);
    const confirmed = markResearchTasksSatisfiedByProduct(
      db,
      localProductId,
      product,
      {
        note: options.researchEvidenceTitle ?? options.note,
        source: options.source ?? "user",
      },
    );
    const saved = getProduct(db, localProductId);
    if (!saved) throw new Error("产品不存在");
    return { product: saved, confirmedTaskIds: confirmed.taskIds };
  });
  return tx();
}
