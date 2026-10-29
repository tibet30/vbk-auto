/**
 * 交通子产品按母产品同步天数失败时的运营提示。
 *   - durationSyncFailureReason：把「子产品仍为旧 N 天，未与母产品同步」前置到失败原因；
 *   - durationSyncNote：从失败原因里取出该提示，供跳过标签与结案汇总展示。
 */

import type { TrafficLineVariant } from "./contracts-traffic-line.js";
import { trafficSkipReason } from "./traffic-skip-reason.js";

const NOTE_PATTERN = /子产品(?:可能)?仍为旧(?: \d+ 天|天数)，未与母产品同步/u;

/**
 * childDays 已知时写明旧天数；compared=false 表示母子天数比较本身失败，只能说「可能」。
 * 前置提示不得改变跳过分类（如整句匹配的「当前无可售资源」），否则保留原文。
 */
export function durationSyncFailureReason(
  detail: string, childDays: number | undefined, compared = true, variant?: TrafficLineVariant,
): string {
  const note = !compared ? "子产品可能仍为旧天数，未与母产品同步"
    : childDays ? `子产品仍为旧 ${childDays} 天，未与母产品同步` : "子产品仍为旧天数，未与母产品同步";
  if (NOTE_PATTERN.test(detail)) return detail;
  const reason = `${note}：${detail}`;
  return trafficSkipReason(reason, variant) === trafficSkipReason(detail, variant) ? reason : detail;
}

export function durationSyncNote(reason: string | undefined): string | undefined {
  return reason?.match(NOTE_PATTERN)?.[0];
}
