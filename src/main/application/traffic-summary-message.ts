import type { AgentSnapshot, ProductDetail } from '../../shared/contracts.js';
import { trafficLineLabel, type TrafficLineConfig } from '../../shared/contracts-traffic-line.js';
import { trafficChildOutcomes } from '../../shared/traffic-child-outcome.js';
import { TRAFFIC_SKIP_LABELS } from '../../shared/traffic-skip-reason.js';
import { approvalForRun } from '../agent/integration-gates.js';

const MOTHER_VERIFIED = '母产品草稿已通过核验';

/** 母产品结案汇总：如实列出已完成与已跳过的子产品，不把跳过写成完成。 */
export function trafficSummaryMessage(product: ProductDetail, snapshot?: AgentSnapshot): string {
  const approval = approvalForRun(snapshot);
  const config = (product.product.operations as { trafficLine?: TrafficLineConfig } | undefined)?.trafficLine;
  if ((approval && approval.generateTrafficChildren !== true) || !config?.enabled || !config.variants?.length) {
    return `${MOTHER_VERIFIED}；本次未生成子产品`;
  }
  const { completed, skipped } = trafficChildOutcomes(config, product.automation?.trafficLine);
  if (!completed.length && !skipped.length) return `${MOTHER_VERIFIED}；本次未生成子产品`;
  const labels = skipped.map(item => `${trafficLineLabel(item.variant)}（${TRAFFIC_SKIP_LABELS[item.reason]}）`);
  return [MOTHER_VERIFIED,
    ...(completed.length ? [`已完成 ${completed.length} 个子产品`] : []),
    ...(labels.length ? [`已跳过 ${labels.length} 个子产品：${labels.join('、')}`] : []),
  ].join('；');
}
