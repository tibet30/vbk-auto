import type { TrafficLineChildProgress, TrafficLineConfig, TrafficLineVariant, TrafficLineWorkflowProgress } from "./contracts-traffic-line.js";
import { isUnavailableTrafficResourceFailure, trafficChildSkipHandled } from "./traffic-resource-status.js";
import { isTrafficSkipReason, trafficSkipReason, type TrafficSkipReason } from "./traffic-skip-reason.js";
import { durationSyncNote } from "./traffic-duration-sync.js";

export interface TrafficChildOutcomes {
  completed: TrafficLineChildProgress[];
  /** note：附加提示，例如子产品仍为旧天数、未与母产品同步。 */
  skipped: Array<{ variant: TrafficLineVariant; reason: TrafficSkipReason; note?: string }>;
}

/** 已完成与已跳过子产品的唯一计数口径；结案汇总与 VBK 录入面板共用。 */
export function trafficChildOutcomes(config: Partial<TrafficLineConfig> | undefined, progress: TrafficLineWorkflowProgress | undefined): TrafficChildOutcomes {
  const children = progress?.children ?? [];
  const completed = children.filter(child => child.verified && (child.completedStages ?? []).includes("finalReadback"));
  const skipped: TrafficChildOutcomes["skipped"] = [];
  if (!config?.enabled || !Array.isArray(config.variants)) return { completed, skipped };
  for (const variant of config.variants) {
    const child = children.find(item => item.variant === variant);
    if (child && completed.includes(child)) continue;
    const reason = child?.failureReason ?? progress?.unavailableVariants?.[variant];
    const handled = child ? trafficChildSkipHandled(child) || isUnavailableTrafficResourceFailure(reason ?? "", variant)
      : Boolean(reason && isUnavailableTrafficResourceFailure(reason, variant));
    if (!handled) continue;
    const note = durationSyncNote(reason);
    skipped.push({ variant, reason: isTrafficSkipReason(child?.skipReason) ? child.skipReason : trafficSkipReason(reason ?? "", variant),
      ...(note ? { note } : {}) });
  }
  return { completed, skipped };
}
