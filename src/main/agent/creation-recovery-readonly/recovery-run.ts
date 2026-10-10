/**
 * recovery run / scope / 输入工具：
 *   - parseRecoveryScope：scope 解析从 args.scope 仅允许 "all" / "parent-only"；
 *   - requireProduct：DB 取产品；缺失即抛错；
 *   - recoveryInput：把 product + scope 收敛为 RecoveryInput；
 *       * 检查 traffic.availability 与 endpointPlan 是否已被本会话核验；
 *       * 若启用交通但 variants 不可用或 endpointPlan 缺失 → 拒绝（不能
 *         把历史交通阶段恢复为完成）；
 *   - uniqueVariants：去重；重复 → 抛错；
 *   - assertUnsubmittedDraft：variant 必须是 draft 且 unsubmittedDraftVerified；
 *     缺 draftId 同样抛错。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import type { TrafficLineVariant } from "../../../shared/contracts-traffic-line.js";
import { normaliseTrafficLineConfig, normaliseTrafficLineVariant, trafficLineLabel } from "../../../shared/contracts-traffic-line.js";
import { draftPhasesFor } from "../../automation/automation.main/automation.main.phases.js";
import type { CreationRecoveryReadOnlyDependencies, RecoveryInput, RecoveryScope } from "./types.js";

export function parseRecoveryScope(args: Record<string, unknown>): RecoveryScope {
  const value = args.scope;
  if (value === undefined || value === "all") return "all";
  if (value === "parent-only") return "parent-only";
  throw new Error("scope 只能是 all 或 parent-only。");
}

export function requireProduct(deps: CreationRecoveryReadOnlyDependencies, localProductId: string): ProductDetail {
  const product = deps.db.getProduct(localProductId);
  if (!product) throw new Error("产品不存在，无法执行只读恢复。");
  return product;
}

export function recoveryInput(product: ProductDetail, scope: RecoveryScope): RecoveryInput {
  const productId = product.productId?.trim();
  if (!productId) throw new Error("当前产品没有已保存的 VBK productId；不能安全恢复，也不会创建产品。");
  const traffic = normaliseTrafficLineConfig((product.product.operations as Record<string, unknown> | undefined)?.trafficLine);
  const availability = traffic?.availability;
  const variants = uniqueVariants(traffic?.variants ?? [], "产品交通计划");
  // An explicitly disabled traffic plan has no traffic child to verify. It is
  // safe to recover the complete parent draft without inventing endpoints or
  // forcing a parent-only recovery solely because a historical run had one.
  const requiresTrafficReadback = scope === "all" && traffic?.enabled === true;
  if (requiresTrafficReadback) {
    if (!traffic?.enabled || !variants.length || !availability?.endpointPlan) {
      throw new Error("缺少当前会话已核验的大交通端点计划；不能把历史交通阶段恢复为完成。");
    }
    const available = uniqueVariants(availability.availableVariants, "交通可用方式");
    if (variants.length !== available.length || variants.some((variant) => !available.includes(variant))) {
      throw new Error("交通计划与当前会话已核验的可用方式不一致，不能混合历史结果恢复。");
    }
    for (const variant of variants) {
      if (variant === "flightRoundTrip" && !availability.endpointPlan.flight) {
        throw new Error("飞机往返缺少已核验端点计划，不能恢复。");
      }
      if (variant === "trainRoundTrip" && !availability.endpointPlan.train) {
        throw new Error("火车往返缺少已核验端点计划，不能恢复。");
      }
    }
  }
  // Lazy import to avoid cycle with snapshots.ts (which imports this file).
  const { productJsonSnapshot, workflowSnapshot } = require("./snapshots.js") as typeof import("./snapshots.js");
  return {
    product,
    productId,
    productJsonVersion: product.productJsonVersion ?? 0,
    productJsonSnapshot: productJsonSnapshot(product),
    workflowSnapshot: workflowSnapshot(product),
    ...(availability?.endpointPlan ? { endpointPlan: availability.endpointPlan } : {}),
    variants,
  };
}

export function uniqueVariants(values: readonly TrafficLineVariant[], label: string): TrafficLineVariant[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error(`${label}存在重复方式，不能安全恢复。`);
  return unique;
}

export function assertUnsubmittedDraft(readback: import("./types.js").CreationVariantReadback): string {
  if (readback.variant !== "draft" || readback.unsubmittedDraftVerified !== true) {
    throw new Error("未读取到已确认的未提审草稿 variant；不会把 formal、audit 或 preview 结果混作草稿完成证据。");
  }
  const draftId = readback.ids.draft?.trim();
  if (!draftId) throw new Error("未提审草稿回读缺少 draft ID，不能安全恢复。");
  return draftId;
}