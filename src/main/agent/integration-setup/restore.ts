/**
 * integration-setup 中的"恢复"路径：
 *   - restoreExplicitOperatorDeletion：只有用户直接请求（恢复 / 加回 / 新增 /
 *     重新加入 / 保留）时，撤销一次手动删除 receipt；只在 mentionsDay /
 *     restoreContextIdentifiesReceipt 都通过时撤销，避免同 slot 同 name
 *     的多个 OR 选项被批量撤销；
 *   - mentionsDay：识别「第 N 天 / D N / 第 X 天」写法（中文一..十）；
 *   - restoreContextIdentifiesReceipt：OR 组内若 slot 重名，用同行 peer 名（or receipt
 *     关联的组）做反向佐证；
 *   - restoreExplicitAlternativeSlots：recreate 旧 auto-removed explicit alternatives
 *     到本地行程，仅在用户明确请求时跑（恢复 / 加回 / 新增 / 重新加入 / 保留 /
 *     修改 / 调整）。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import { clearTrustedOperatorItineraryRemoval, trustedOperatorItineraryRemovals } from "../../../shared/trusted-operator-itinerary-removals.js";
import { explicitAlternativeGroups } from "../../planning/itinerary-input-contract.js";
import { restoreExplicitAlternativeGroupSpots } from "../../planning/restore-explicit-itinerary-spots.js";
import { extractLockedConstraints } from "../prompt-helpers.js";

/** Only a direct user request can revoke an exact manual deletion receipt. */
export function restoreExplicitOperatorDeletion(product: Record<string, unknown>, content: string): boolean {
  if (!/(恢复|加回|新增|重新加入|保留)/.test(content)) return false;
  let changed = false;
  const receipts = trustedOperatorItineraryRemovals(product);
  for (const receipt of receipts) {
    if (!content.replace(/\s+/g, "").includes(receipt.name.replace(/\s+/g, ""))) continue;
    if (!mentionsDay(content, receipt.day)) continue;
    if (!restoreContextIdentifiesReceipt(receipt, receipts, content)) continue;
    changed = clearTrustedOperatorItineraryRemoval(product, receipt.day, receipt.name, receipt.groupKey) || changed;
  }
  return changed;
}

function restoreContextIdentifiesReceipt(
  receipt: ReturnType<typeof trustedOperatorItineraryRemovals>[number],
  receipts: ReturnType<typeof trustedOperatorItineraryRemovals>, content: string,
): boolean {
  const sameSlotName = receipts.filter((item) => item.day === receipt.day && item.name.replace(/\s+/g, "") === receipt.name.replace(/\s+/g, ""));
  if (sameSlotName.length === 1) return true;
  if (!receipt.groupKey?.startsWith(`or:${receipt.day}:`)) return false;
  const peers = receipt.groupKey.slice(`or:${receipt.day}:`.length).split("")
    .filter((name) => name && name !== receipt.name.replace(/\s+/g, ""));
  const compact = content.replace(/\s+/g, "");
  return peers.some((name) => compact.includes(name));
}

export function mentionsDay(content: string, day: number): boolean {
  const chinese = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][day] ?? "";
  return new RegExp(`(?:第${day}(?:天|日)|[dD]${day}\\b|第${chinese}天)`).test(content);
}

/** Recreate old auto-removed explicit alternatives locally before any new run. */
export function restoreExplicitAlternativeSlots(detail: ProductDetail, content: string): Record<string, unknown> | undefined {
  if (!/(?:恢复|加回|新增|重新加入|保留|修改|调整)/u.test(content)) return undefined;
  const locked = extractLockedConstraints(detail);
  let itinerary = detail.product.itinerary;
  let changed = false;
  for (const group of explicitAlternativeGroups(detail)) {
    const row = locked.itineraryOrder.find((item) => item.day === group.day);
    if (!row) continue;
    const result = restoreExplicitAlternativeGroupSpots(detail, itinerary, row.spots, group);
    if (!result.changed) continue;
    itinerary = result.itinerary;
    changed = true;
  }
  return changed ? { ...detail.product, itinerary } : undefined;
}