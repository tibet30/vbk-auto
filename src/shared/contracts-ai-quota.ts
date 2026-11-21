/** 网关额度快照的渲染端契约：上游窗口剩余与个人当月用量。 */

export interface AiQuotaUpstreamSnapshot {
  available: boolean;
  reason: string;
  intervalRemainingPercent: number | null;
  intervalEndsAt: string | null;
  weeklyRemainingPercent: number | null;
  weeklyEndsAt: string | null;
}

export interface AiQuotaSnapshot {
  periodKey: string;
  memberUsedBillableTokens: number;
  memberLimitBillableTokens: number | null;
  memberRemainingPercent: number | null;
  upstream: AiQuotaUpstreamSnapshot;
}
