import type { TrafficLineVariant } from "./contracts-traffic-line.js";
import { isUnavailableTrafficResourceFailure } from "./traffic-resource-status.js";

/** 子产品被跳过的真实原因；只用于展示与母产品结案，不影响重试阶段。 */
export type TrafficSkipReason = "platform_unavailable" | "local_inventory_missing" | "child_failed";

export const TRAFFIC_SKIP_LABELS: Record<TrafficSkipReason, string> = {
  platform_unavailable: "平台当前无可售交通资源",
  local_inventory_missing: "本地未配置销售班期，请在价格库存班期补充后重试",
  child_failed: "子产品录入失败，已跳过",
};

export function trafficSkipReason(reason: string, variant?: TrafficLineVariant): TrafficSkipReason {
  // 本地价格库存缺班期是运营可补的配置缺口，不能说成平台没有资源。
  if (/没有可用于交通资源核验的销售班期/.test(reason)) return "local_inventory_missing";
  if (isUnavailableTrafficResourceFailure(reason, variant)) return "platform_unavailable";
  return "child_failed";
}

export function isTrafficSkipReason(value: unknown): value is TrafficSkipReason {
  return typeof value === "string" && Object.hasOwn(TRAFFIC_SKIP_LABELS, value);
}
