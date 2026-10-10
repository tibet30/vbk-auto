/**
 * review-summary-basic-info 工具：
 *   - sameContactCard：两个 ContactCardSelection 是否指向同一联系人；
 *   - buildHeadParts：根据当前 snapshot + 账号默认值派生 headParts
 *     「封面 / 副标题待补充 / 管家待补充 / 400 电话待设置 / ...」数组，
 *     用车按产品类型条件加入；
 *   - deriveInventoryDraft / derivePricingDraft：从父级 draft 提取三字段草稿。
 */

import type { ContactCardSelection } from "../../../../../shared/contracts-types.js";
import type { BasicInfoSnapshot } from "./types.js";

export function sameContactCard(
  left: ContactCardSelection | null,
  right: ContactCardSelection | null,
): boolean {
  return Boolean(
    left
    && right
    && left.contactCardId === right.contactCardId
    && left.providerId === right.providerId
    && left.displayName.trim() === right.displayName.trim(),
  );
}

export function buildHeadParts(
  snapshot: BasicInfoSnapshot,
  servicePhoneRaw: string,
  vehicleVisible: boolean,
  vehicleHasValue: boolean,
): string[] {
  const subtitleHasValue = snapshot.subtitle !== null;
  const butlerHasValue = snapshot.butler !== null;
  const servicePhoneHasValue = servicePhoneRaw.length > 0;
  const pricingHasValue = snapshot.adult !== null
    && snapshot.child !== null
    && snapshot.minimumTravelers !== null;
  const inventoryHasValue = snapshot.inventory.startDate !== null
    && snapshot.inventory.endDate !== null
    && snapshot.inventory.dailyQuota !== null;
  const parts: string[] = [];
  parts.push(snapshot.coverFallback ? "封面待替换" : "封面");
  parts.push(subtitleHasValue ? "副标题" : "副标题待补充");
  parts.push(butlerHasValue ? "管家" : "管家待补充");
  parts.push(servicePhoneHasValue ? "400 电话" : "400 电话待设置");
  parts.push(pricingHasValue ? "定价" : "定价待设置");
  parts.push(inventoryHasValue ? "库存" : "库存待设置");
  if (vehicleVisible) {
    parts.push(vehicleHasValue ? "用车" : "用车待匹配");
  }
  return parts;
}

export interface PricingDraft {
  adult: string;
  child: string;
  minimumTravelers: string;
}

export interface InventoryDraft {
  startDate: string;
  endDate: string;
  dailyQuota: string;
}

export function derivePricingDraft(draft: Record<string, string>): PricingDraft {
  return {
    adult: draft.adult ?? "",
    child: draft.child ?? "",
    minimumTravelers: draft.minimumTravelers ?? "",
  };
}

export function deriveInventoryDraft(draft: Record<string, string>): InventoryDraft {
  return {
    startDate: draft.startDate ?? "",
    endDate: draft.endDate ?? "",
    dailyQuota: draft.dailyQuota ?? "",
  };
}

export type { ContactCardSelection };