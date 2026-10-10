/**
 * 产品 / 自动化阶段快照：
 *   - productJsonSnapshot：删除 diagnostics 后做 canonical JSON 序列化（key 字典序排序）；
 *   - canonical：把对象键按字典序排序后再序列化，让同语义数据得到同一字符串；
 *   - workflowSnapshot：status / automation / trafficLine 三字段。
 *
 * assertUnchanged：核验 productId / productJson / status&automation&trafficLine
 *   是否在恢复读取期间被改动；任一变化都拒绝写入恢复检查点。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import type { CreationRecoveryReadOnlyDependencies, RecoveryInput } from "./types.js";

export function productJsonSnapshot(product: ProductDetail): string {
  const data = structuredClone(product.product) as Record<string, unknown>;
  delete data.diagnostics;
  return JSON.stringify(canonical(data));
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function workflowSnapshot(product: ProductDetail): string {
  return JSON.stringify({ status: product.status, automation: product.automation, trafficLine: (product.product.operations as Record<string, unknown> | undefined)?.trafficLine });
}

export function assertUnchanged(deps: CreationRecoveryReadOnlyDependencies, localProductId: string, initial: RecoveryInput): void {
  const current = requireProductLocal(deps, localProductId);
  const changes: string[] = [];
  if (current.productId?.trim() !== initial.productId) changes.push("productId");
  if (productJsonSnapshot(current) !== initial.productJsonSnapshot) changes.push("productJson");
  if (workflowSnapshot(current) !== initial.workflowSnapshot) changes.push("status/automation/trafficLine");
  if (changes.length) {
    throw new Error(`恢复读取期间产品或自动化流程版本已变化（变化字段：${changes.join("、")}），未写入本地完成状态。`);
  }
}

function requireProductLocal(deps: CreationRecoveryReadOnlyDependencies, localProductId: string): ProductDetail {
  return requireProduct(deps, localProductId);
}

// Imported here so callers don't need to chase the dependency chain.
import { requireProduct } from "./recovery-run.js";