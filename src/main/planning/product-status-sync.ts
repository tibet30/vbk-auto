/**
 * 产品状态 ↔ 规划生成态同步助手。
 *
 * 关键不变量：
 *   - 规划进入失败 / 需要补齐时，仅当 products.status 当前是 planning 才推到 blocked；
 *     review / automating / draft_saved 等活跃状态不被动，避免「自动化刚把产品
 *     标 automating 时被规划改回 blocked」之类的状态翻转。
 *   - 用户显式 planning:start / planning:resume 重试失败的规划时，仅当产品当前
 *     是 blocked 且持久化 planning_generation.status 处于 failed / needs_user，
 *     才把 products.status 恢复为 planning；其他来源的 blocked（自动化孤儿恢复、
 *     运营手工干预）保持原状。
 *   - completed 路径：仅当 products.status 是 planning 时推到 review，与旧行为一致。
 *
 * 集中到这一个文件的目的：
 *   - 决策（pure）与副作用（DB 写入）分层，让单测聚焦在决策层面；
 *   - main.ts 里 runPlanning / handlePreflightFailure / planning:start / planning:resume
 *     四处复用同一组规则，避免 if/else 散落导致行为漂移；
 *   - 后续若要再叠加「running 同步时态」「draft_saved 保持」等新规则，只改一处。
 */

import type { VbkDatabase } from "../infrastructure/database/database.js";

/** 规划子系统对外承诺的三种终态；其他 planning_generation.status（pending / running）属于中间态。 */
export type PlanningFinalStatus = "completed" | "needs_user" | "failed";

/** PlanningGenerationState.status 白名单里「失败 / 需要补齐」的子集。 */
export const PLANNING_FAILURE_STATUSES = new Set<PlanningFinalStatus>(["failed", "needs_user"]);

/** products.status 同步决策的最小契约类型，便于 main.ts 调用方与单测共享。 */
export interface ProductsStatusSyncDecision {
  /** 是否应把产品状态写到 newStatus。 */
  apply: boolean;
  /** 准备写入的新状态；当 apply=false 时无意义。 */
  newStatus: "blocked" | "review" | "planning";
}

/**
 * 决策：规划跑出 runStatus 时，products.status 是否需要被推到 blocked。
 *
 *  规则：
 *   - runStatus ∈ { failed, needs_user } 且 products.status === "planning" → apply=true，newStatus="blocked"；
 *   - 其他情况 apply=false；不动 review / automating / draft_saved / blocked。
 */
export function shouldSyncProductToBlocked(args: {
  runStatus: PlanningFinalStatus;
  productStatus: string | undefined;
}): ProductsStatusSyncDecision {
  if (args.runStatus !== "failed" && args.runStatus !== "needs_user") return { apply: false, newStatus: "blocked" };
  if (args.productStatus !== "planning") return { apply: false, newStatus: "blocked" };
  return { apply: true, newStatus: "blocked" };
}

/**
 * 决策：规划跑出 runStatus 时，products.status 是否需要被推到 review。
 *
 *  规则：仅当 products.status === "planning" 时把 review 写下去，覆盖其他状态是不安全的
 *  （例如：被自动化运行时已经标 automating、已经标 review 等待运营确认），
 *  旧行为已采用该约束；保留为函数形式以便与 shouldSyncProductToBlocked 对称。
 */
export function shouldSyncProductToReview(args: {
  productStatus: string | undefined;
  allowBlockedAfterRetry?: boolean;
}): ProductsStatusSyncDecision {
  if (args.allowBlockedAfterRetry && args.productStatus === "blocked") return { apply: true, newStatus: "review" };
  if (args.productStatus !== "planning") return { apply: false, newStatus: "review" };
  return { apply: true, newStatus: "review" };
}

/**
 * 决策：用户显式 planning:start / planning:resume 重试时，products.status 是否需要
 * 从 blocked → planning 恢复。
 *
 *  规则：仅当 products.status === "blocked" 且持久化 planning_generation.status ∈
 *  { failed, needs_user } 时才能恢复。其他来源的 blocked（自动化孤儿恢复、运营手工、
 *  持久化状态为 completed / running / pending / 不存在）一律不恢复，否则会出现
 *  「自动化把产品改 automating→blocked 后被规划重试又翻回 planning」这种不该有的回归。
 */
export function shouldRestoreProductToPlanning(args: {
  productStatus: string | undefined;
  planningGenerationStatus: string | undefined;
}): ProductsStatusSyncDecision {
  if (args.productStatus !== "blocked") return { apply: false, newStatus: "planning" };
  if (!PLANNING_FAILURE_STATUSES.has(args.planningGenerationStatus as PlanningFinalStatus)) {
    return { apply: false, newStatus: "planning" };
  }
  return { apply: true, newStatus: "planning" };
}

// ────────────────────────────────────────────────────────────────────────────
// Side-effecting helpers：纯函数 + DB 写。main.ts 直接调用这些函数；单测也可
// 在不依赖 IPC 的前提下，单纯通过 VbkDatabase 验证所有转换分支。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 供 handlePreflightFailure 调用：preflight / runPlan 之外抛错走该函数。
 * 返回 { applied } 而非 boolean，便于上层打日志时区分「没改」与「改了」。
 */
export function syncProductStatusAfterFailure(db: VbkDatabase, localProductId: string): { applied: boolean } {
  const product = db.getProduct(localProductId);
  if (!product) return { applied: false };
  const decision = shouldSyncProductToBlocked({ runStatus: "failed", productStatus: product.status });
  if (!decision.apply) return { applied: false };
  db.updateProduct(product.id, product.product, "blocked");
  return { applied: true };
}

/**
 * 供 runPlanning 调用：runPlan 返回后做最终态同步。
 *  - runStatus="completed"：仅当 products.status=planning → review；
 *  - runStatus ∈ { failed, needs_user }：仅当 products.status=planning → blocked；
 *  - 其他返回值（理论不存在）：不做任何事。
 *  注意不在这里写 assistant 消息 / emitProduct——那是 main.ts 自己的责任，
 *  本函数只负责 products.status 字段同步，方便单测聚焦。
 */
export function syncProductStatusAfterRunPlan(
  db: VbkDatabase,
  localProductId: string,
  runStatus: PlanningFinalStatus,
  options: { allowBlockedToReviewOnCompletion?: boolean } = {},
): { applied: boolean } {
  const product = db.getProduct(localProductId);
  if (!product) return { applied: false };
  if (runStatus === "completed") {
    const decision = shouldSyncProductToReview({
      productStatus: product.status,
      allowBlockedAfterRetry: options.allowBlockedToReviewOnCompletion,
    });
    if (!decision.apply) return { applied: false };
    db.updateProduct(product.id, product.product, "review");
    return { applied: true };
  }
  if (runStatus === "failed" || runStatus === "needs_user") {
    const decision = shouldSyncProductToBlocked({ runStatus, productStatus: product.status });
    if (!decision.apply) return { applied: false };
    db.updateProduct(product.id, product.product, "blocked");
    return { applied: true };
  }
  return { applied: false };
}

/**
 * 供 planning:start / planning:resume 用户显式重试时调用：
 *  - planningGenerationStatus 是 main.ts 调 db.loadPlanningState 拿到的值；
 *    planning:resume 时该值就是已经存在的 state.status；planning:start 时也是
 *    main 在写新的 pending 之前查到的旧 state.status。
 *  - 仅当 products.status=blocked 且 planningGenerationStatus ∈ { failed, needs_user }
 *    才把 products.status 改回 planning；其他状态一律不动。
 *  - 返回 { restored, newStatus }：restored=true 时 newStatus 是写下去的状态，
 *    restored=false 时 newStatus 恒为当前 products.status（便于日志里区分）。
 *
 *  注意：调用方必须在调本函数之后才把 planning_state 持久化为新状态；否则本函数读到的
 *  还是旧的 planning_generation.status（这正是想要的语义——只对「明确失败」恢复）。
 */
export function restoreProductToPlanningForRetry(
  db: VbkDatabase,
  localProductId: string,
  planningGenerationStatus: string | undefined,
): { restored: boolean; newStatus: string } {
  const product = db.getProduct(localProductId);
  if (!product) return { restored: false, newStatus: "unknown" };
  const decision = shouldRestoreProductToPlanning({
    productStatus: product.status,
    planningGenerationStatus,
  });
  if (!decision.apply) return { restored: false, newStatus: product.status };
  db.updateProduct(product.id, product.product, "planning");
  return { restored: true, newStatus: "planning" };
}
