/**
 * integration-setup 中的"恢复"路径：
 *   - restoreExplicitOperatorDeletion：只有用户直接请求（恢复 / 加回 / 新增 /
 *     重新加入 / 保留，或指明日次的「要有 / 必须 / 加上」且无否定词）时，撤销一次手动删除 receipt；只在 mentionsDay /
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
import { alternativeGroupSegments, clearTrustedOperatorItineraryRemoval, trustedOperatorItineraryRemovals } from "../../../shared/trusted-operator-itinerary-removals.js";
import { itinerarySpotKey } from "../../../shared/itinerary-spot-identity.js";
import { withoutScenicSuffix } from "../../../shared/poi-original-route-identity.js";
import { REJECT_DAY_SPOT_VERB, REQUIRE_DAY_SPOT_VERB } from "../../../shared/explicit-day-spot-requirement.js";
import { explicitAlternativeGroups } from "../../planning/itinerary-input-contract.js";
import { restoreExplicitAlternativeGroupSpots } from "../../planning/restore-explicit-itinerary-spots.js";
import { extractLockedConstraints } from "../prompt-helpers.js";

const RESTORE_VERB = /(恢复|加回|新增|重新加入|保留)/u;

/** Only a direct user request can revoke an exact manual deletion receipt. */
export function restoreExplicitOperatorDeletion(product: Record<string, unknown>, content: string): boolean {
  const restore = RESTORE_VERB.test(content);
  // 「第四天要有九寨沟的景区」：指明日次并要求必须有该景点，同样是明确恢复。
  if (!restore && !(REQUIRE_DAY_SPOT_VERB.test(content) && !REJECT_DAY_SPOT_VERB.test(content))) return false;
  let changed = false;
  const receipts = trustedOperatorItineraryRemovals(product);
  for (const receipt of receipts) {
    if (!namesReceipt(content, receipt, !restore)) continue;
    if (!mentionsDay(content, receipt.day)) continue;
    if (!restoreContextIdentifiesReceipt(receipt, receipts, content)) continue;
    changed = clearTrustedOperatorItineraryRemoval(product, receipt.day, receipt.name, receipt.groupKey) || changed;
  }
  return changed;
}

/** 恢复动词按原名匹配；「要有」句式还接受去掉景区类别尾缀的原站名（九寨沟 ↔ 九寨沟风景区）。 */
function namesReceipt(content: string, receipt: ReturnType<typeof trustedOperatorItineraryRemovals>[number], bare: boolean): boolean {
  const compact = content.replace(/\s+/g, "");
  const names = [receipt.name, receipt.poiName ?? ""].map((name) => name.replace(/\s+/g, "")).filter(Boolean);
  if (names.some((name) => compact.includes(name))) return true;
  return bare && names.map(withoutScenicSuffix).some((name) => name.length >= 2 && compact.includes(name));
}

function restoreContextIdentifiesReceipt(
  receipt: ReturnType<typeof trustedOperatorItineraryRemovals>[number],
  receipts: ReturnType<typeof trustedOperatorItineraryRemovals>, content: string,
): boolean {
  const key = itinerarySpotKey(receipt.name);
  const sameSlotName = receipts.filter((item) => item.day === receipt.day && itinerarySpotKey(item.name) === key);
  if (sameSlotName.length === 1) return true;
  // groupKey 各段以 \u001f 分隔；逐段按 itinerarySpotKey 归一化后比较。
  const segments = receipt.groupKey ? alternativeGroupSegments(receipt.groupKey, receipt.day) : undefined;
  if (!segments) return false;
  const peers = segments.filter((name) => name && name !== key);
  // 用户原文是整句，只去空白后做包含判断，不做名称键归一化。
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