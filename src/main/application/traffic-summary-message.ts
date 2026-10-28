import type { AgentSnapshot, ProductDetail } from '../../shared/contracts.js';
import { trafficLineLabel, type TrafficLineConfig, type TrafficLineVariant } from '../../shared/contracts-traffic-line.js';
import { isUnavailableTrafficResourceFailure, trafficChildSkipHandled } from '../../shared/traffic-resource-status.js';
import { TRAFFIC_SKIP_LABELS, isTrafficSkipReason, trafficSkipReason } from '../../shared/traffic-skip-reason.js';
import { approvalForRun } from '../agent/integration-gates.js';

const MOTHER_VERIFIED = '母产品草稿已通过核验';

/** 母产品结案汇总：如实列出已完成与已跳过的子产品，不把跳过写成完成。 */
export function trafficSummaryMessage(product: ProductDetail, snapshot?: AgentSnapshot): string {
  const approval = approvalForRun(snapshot);
  const config = (product.product.operations as { trafficLine?: TrafficLineConfig } | undefined)?.trafficLine;
  if ((approval && approval.generateTrafficChildren !== true) || !config?.enabled || !config.variants?.length) {
    return `${MOTHER_VERIFIED}；本次未生成子产品`;
  }
  const progress = product.automation?.trafficLine;
  const children = progress?.children ?? [];
  const completed = children.filter(child => child.verified && (child.completedStages ?? []).includes('finalReadback'));
  const skipped: string[] = [];
  for (const variant of config.variants) {
    const child = children.find(item => item.variant === variant);
    if (child && completed.includes(child)) continue;
    const reason = child?.failureReason ?? progress?.unavailableVariants?.[variant];
    const handled = child ? trafficChildSkipHandled(child) || isUnavailableTrafficResourceFailure(reason ?? '', variant)
      : Boolean(reason && isUnavailableTrafficResourceFailure(reason, variant));
    if (handled) skipped.push(skippedLabel(variant, child?.skipReason, reason));
  }
  if (!completed.length && !skipped.length) return `${MOTHER_VERIFIED}；本次未生成子产品`;
  return [MOTHER_VERIFIED,
    ...(completed.length ? [`已完成 ${completed.length} 个子产品`] : []),
    ...(skipped.length ? [`已跳过 ${skipped.length} 个子产品：${skipped.join('、')}`] : []),
  ].join('；');
}

function skippedLabel(variant: TrafficLineVariant, skipReason: unknown, reason: string | undefined): string {
  const kind = isTrafficSkipReason(skipReason) ? skipReason : trafficSkipReason(reason ?? '', variant);
  return `${trafficLineLabel(variant)}（${TRAFFIC_SKIP_LABELS[kind]}）`;
}
