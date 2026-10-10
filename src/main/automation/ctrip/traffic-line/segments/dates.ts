/**
 * 交通资源核验日期选择：
 *   - trafficLineResourceCheckDates：从产品 commercial.inventory.startDate / endDate
 *     选前 3 个满足 advanceBooking 规则的日期（最早可订 = today + booking.days + 1）；
 *   - resourceCheckSchedule：把 caller 传入的 schedule 过滤为去重 + 合法 YYYY-MM-DD；
 *   - deterministicSchedule：当 caller 没传 schedule 时，给 14 天后的一个真实班期；
 *     仅用于直接调用的兼容路径。
 *
 * 仅探测满足提前预订的近期真实班期：
 *   - submitSegments 是资源可用性探测，不是价格库存落库；
 *   - 今天违反预订规则的远期酒店/车票可能尚不可订，不能据此断定没有资源。
 */

import { resolveAdvanceBooking } from "../../../schema/schema-functions.js";
import { datesBetween, localBusinessDate, VBK_MAX_PRICING_INVENTORY_DAYS } from "../../pricing-api.js";
import { record, text } from "../client.js";

export function trafficLineResourceCheckDates(
  product: Record<string, unknown> | undefined,
  now = new Date(),
): string[] {
  const commercial = record(product?.commercial);
  const inventory = record(commercial?.inventory);
  const startDate = text(inventory?.startDate);
  const endDate = text(inventory?.endDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    return [];
  }
  const booking = resolveAdvanceBooking(product ?? {});
  if (!booking) return [];
  const earliest = new Date(now);
  earliest.setDate(earliest.getDate() + Math.max(1, booking.days + 1));
  const availableDates = datesBetween(startDate, endDate)
    .filter((date) => date >= localBusinessDate(earliest))
    .slice(0, VBK_MAX_PRICING_INVENTORY_DAYS);
  return availableDates.slice(0, 3);
}

export function resourceCheckSchedule(schedule: readonly string[] | undefined, now = new Date()): string[] {
  const valid = [...new Set(schedule?.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) ?? [])];
  // 仅供直接调用的兼容路径；正常交通主流程必须传入产品班期。
  return valid.length ? valid : deterministicSchedule(now);
}

export function deterministicSchedule(now = new Date()): string[] {
  return [14].map((offset) => {
    const date = new Date(now); date.setDate(date.getDate() + offset); return date.toISOString().slice(0, 10);
  });
}