/**
 * itinerary-input-contract 共用工具：
 *   - DAY_TOKEN：中文/阿拉伯数字 day token → 1..10 映射；
 *   - asDayList / asRecord / text / unique / shortCity：通用归一；
 *   - userMessages：filter user messages；
 *   - spotNames / spotName：从 day.spots 抽 name（含 POI 名称兜底）；
 *   - samePlace：宽松相等（去空白 / 子串包含）；
 *   - isNameSubsequence / missingNames / extraNames：行程名字序列工具；
 *   - isDeletableAdministrativeLocation：可删除的行政地点识别（含基本字段 /
 *     trafficLine / 聊天关键词「删除/移除/去掉」）；
 *   - isSupportingLockedSpot：判断一个 locked spot 是否属于住宿 / 接送段；
 *   - requiresLockedAttraction：检查锁定名是否必须是"景点"（不允许自由活动 /
 *     接团 等活动名掩盖）；
 *   - escapeRegExp：用于生成正则。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import { isAdministrativeLocationName, toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { supportArrangementType } from "../../../shared/itinerary-support-arrangements.js";
import { hasVerifiedRouteAdministrativeNode } from "../../../shared/route-administrative-nodes.js";
import { hasCompletePoi } from "../../../shared/itinerary-activity-kind.js";

export const DAY_TOKEN: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

export function asDayList(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    days.push(item as Record<string, unknown>);
  }
  return days;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function shortCity(value: unknown): string {
  return toPlatformShortLocationName(text(value));
}

export function userMessages(product: ProductDetail): Array<{ role: string; content: string }> {
  return (product.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => ({ role: "user", content: message.content }));
}

export function spotNames(day: Record<string, unknown>): string[] {
  return (Array.isArray(day.spots) ? day.spots : [])
    .flatMap((spot) => {
      if (typeof spot === "string") return [spot.trim()];
      const record = asRecord(spot);
      // POI locks exclude the plain transfer service stripped from the brief.
      // Do not ignore arbitrary kind:"other" nodes or any verified POI.
      if (record?.kind === "other" && !hasCompletePoi(record)
        && /^(?:接火车站?|火车站接|送火车站?|接站|送站|接机|送机|接团|送团)(?:返程)?$/u.test(text(record.name))) return [];
      return record ? [text(record.name) || text(record.poiName)] : [];
    })
    .filter(Boolean);
}

export function spotName(spot: Record<string, unknown>): string {
  return text(spot.name) || text(spot.poiName);
}

export function samePlace(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, "");
  const b = right.replace(/\s+/g, "");
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}

export function isNameSubsequence(haystack: string[], needles: string[]): boolean {
  let index = 0;
  for (const name of haystack) {
    if (index < needles.length && samePlace(name, needles[index]!)) index += 1;
  }
  return index === needles.length;
}

export function missingNames(haystack: string[], needles: string[]): string[] {
  return needles.filter((needle) => !haystack.some((name) => samePlace(name, needle)));
}

export function extraNames(haystack: string[], needles: string[]): string[] {
  return haystack.filter((name) => !needles.some((needle) => samePlace(name, needle)));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function requiresLockedAttraction(name: string): boolean {
  const value = text(name);
  if (/^(?:上午|下午|晚上|全天)?\s*自由活动$/u.test(value)) return false;
  return !/(?:接团|送团|接机|送机|接站|送站|接送|无人机航拍|航拍|办理入住|集合|解散|乘车|返程)(?:服务)?$/u.test(value);
}

export function isSupportingLockedSpot(product: ProductDetail, dayNumber: number, name: string, nextDay?: Record<string, unknown>): boolean {
  const source = (asDayList(product.product.itinerary) ?? []).find(day => Number(day.day) === dayNumber);
  const existing = (Array.isArray(source?.spots) ? source.spots : []).map(asRecord)
    .find(spot => spot && samePlace(spotName(spot), name));
  return Boolean(supportArrangementType(existing ?? { name, kind: "other" }, source ?? nextDay));
}

export function isDeletableAdministrativeLocation(product: ProductDetail, value: string, day?: number): boolean {
  if (hasVerifiedRouteAdministrativeNode(product.product, value, day)) return true;
  if (isAdministrativeLocationName(value)) return true;
  const compact = value.replace(/\s+/g, "");
  if (!compact) return false;
  const basic = asRecord(product.product.basicInfo);
  const operations = asRecord(product.product.operations);
  const trafficLine = asRecord(operations?.trafficLine);
  const productLocationNames = [
    basic?.meetingCity,
    basic?.destinationCity,
    basic?.destination,
    operations?.pickupCity,
    trafficLine?.arrivalCity,
    trafficLine?.departureCity,
  ].map((item) => text(item).replace(/\s+/g, "")).filter(Boolean);
  if (productLocationNames.includes(compact)) return true;
  const raw = [
    text(asRecord(product.product.basicInfo)?.userIdea),
    ...(product.messages ?? []).filter((message) => message.role === "user").map((message) => message.content),
  ].join("\n").replace(/\s+/g, "");
  if (new RegExp(`(?:删除|移除|去掉|取消)(?:[^。；;]{0,40})${escapeRegExp(compact)}(?:[^。；;]{0,40})(?:行政|过境|城市|住宿|散团|节点|POI|poi)`, "u").test(raw)) {
    return true;
  }
  return new RegExp(`${escapeRegExp(compact)}(?:省|市|县|区|旗|自治县|自治旗|地区|盟|自治州|特别行政区)`, "u").test(raw);
}