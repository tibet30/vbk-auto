/**
 * basicInfo.subtitle / operations.vehicleResource 字段写入：
 *   - applyBasicInfoSubtitle：subtitle 长度 2..80（与 schema 一致）；
 *   - applyVehicleResource：requestedTotalCost > 0 或 null 清除；null 时同步
 *     写 sentinel `requestedTotalCostCleared=true`，让下游
 *     targetVehicleTotalCost 能区分「从未设置」与「被用户主动清除」。
 */

import type { ManualReviewFieldInput } from "../../../shared/contracts.js";
import { objectValue } from "./util.js";

export function applyBasicInfoSubtitle(product: Record<string, unknown>, subtitle: string): Record<string, unknown> {
  const trimmed = (subtitle ?? "").trim();
  // 与 schema 保持一致：subtitle 长度 2..80。
  if (trimmed.length < 2) throw new Error("副标题至少需要 2 个字符。");
  if (trimmed.length > 80) throw new Error("副标题不能超过 80 个字符。");
  const next = structuredClone(product) as Record<string, unknown>;
  const basicInfo = objectValue(next.basicInfo);
  basicInfo.subtitle = trimmed;
  next.basicInfo = basicInfo;
  return next;
}

export function applyVehicleResource(
  product: Record<string, unknown>,
  input: Extract<ManualReviewFieldInput, { field: "vehicleResource" }>,
): Record<string, unknown> {
  const next = structuredClone(product) as Record<string, unknown>;
  const operations = objectValue(next.operations);
  const vehicle = { ...objectValue(operations.vehicleResource) };

  // 不存在的子项视为「不动」，null 表示清空 requestedTotalCost。
  if (input.requestedTotalCost !== undefined) {
    if (input.requestedTotalCost === null) {
      // 显式清空「全程预计用车总成本·待核查」：同时写一个 sentinel 字段，让下游
      // targetVehicleTotalCost 能区分「从未设置」与「被用户主动清除」，
      // 避免后续自动匹配继续使用已清空的全程用车总成本。
      delete vehicle.requestedTotalCost;
      delete vehicle.requestedDailyCost;
      vehicle.requestedTotalCostCleared = true;
    } else {
      if (!Number.isFinite(input.requestedTotalCost) || input.requestedTotalCost <= 0) {
        throw new Error("全程预计用车总成本必须大于 0，或传 null 清除。");
      }
      vehicle.requestedTotalCost = input.requestedTotalCost;
      delete vehicle.requestedDailyCost;
      // 重新设值时把上一次的清除标记也撤销，否则旧的「已清除」语义会污染
      // 新一轮的估算路径。
      delete vehicle.requestedTotalCostCleared;
      delete vehicle.requestedDailyCostCleared;
    }
  }

  operations.vehicleResource = vehicle;
  next.operations = operations;
  return next;
}

export type { ManualReviewFieldInput };