/** 网关额度快照的渲染端契约：上游窗口剩余与个人当月用量。 */

export interface AiQuotaUpstreamSnapshot {
  available: boolean;
  reason: string;
  intervalRemainingPercent: number | null;
  intervalEndsAt: string | null;
  weeklyRemainingPercent: number | null;
  weeklyEndsAt: string | null;
}

export interface AiQuotaRequestState {
  id: number;
  status: "pending" | "approved" | "rejected";
  requestedBillableTokens: number;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string;
}

export interface AiQuotaSnapshot {
  periodKey: string;
  memberUsedBillableTokens: number;
  memberLimitBillableTokens: number | null;
  memberRemainingPercent: number | null;
  request: AiQuotaRequestState | null;
  upstream: AiQuotaUpstreamSnapshot;
}

export interface AiQuotaRequestInput {
  requestedBillableTokens: number;
  reason: string;
}
