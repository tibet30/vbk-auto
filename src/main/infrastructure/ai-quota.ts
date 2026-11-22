/**
 * 网关额度快照：读取 5 小时/周窗口剩余与个人当月用量，供界面展示。
 */

import type { AppAuthStore } from "./app-auth-store.js";
import { resolveTibetApiBaseUrl } from "./tibet-auth.js";

const REQUEST_TIMEOUT_MS = 8_000;

export interface AiQuotaUpstream {
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
  upstream: AiQuotaUpstream;
}

interface QuotaEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUpstream(value: unknown): AiQuotaUpstream {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    available: raw.available === true,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    intervalRemainingPercent: numberOrNull(raw.intervalRemainingPercent),
    intervalEndsAt: typeof raw.intervalEndsAt === "string" ? raw.intervalEndsAt : null,
    weeklyRemainingPercent: numberOrNull(raw.weeklyRemainingPercent),
    weeklyEndsAt: typeof raw.weeklyEndsAt === "string" ? raw.weeklyEndsAt : null,
  };
}

export async function fetchAiQuota(
  store: AppAuthStore,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<AiQuotaSnapshot> {
  const session = store.get();
  if (!session?.token) throw new Error("请先登录账号后再查看额度。");

  const baseUrl = resolveTibetApiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/api/ai/gateway/quota`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "application/json", Authorization: `Bearer ${session.token}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("登录已失效，请重新登录后再查看额度。");
  }
  const envelope = await response.json() as QuotaEnvelope;
  if (envelope.code !== 200 || !envelope.data) {
    throw new Error(envelope.message || "额度服务暂时不可用。");
  }
  const data = envelope.data as Record<string, unknown>;
  return {
    periodKey: typeof data.periodKey === "string" ? data.periodKey : "",
    memberUsedBillableTokens: numberOrNull(data.memberUsedBillableTokens) ?? 0,
    memberLimitBillableTokens: numberOrNull(data.memberLimitBillableTokens),
    memberRemainingPercent: numberOrNull(data.memberRemainingPercent),
    request: normalizeRequest(data.request),
    upstream: normalizeUpstream(data.upstream),
  };
}

function normalizeRequest(value: unknown): AiQuotaRequestState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  if (status !== "pending" && status !== "approved" && status !== "rejected") return null;
  return {
    id: numberOrNull(raw.id) ?? 0,
    status,
    requestedBillableTokens: numberOrNull(raw.requestedBillableTokens) ?? 0,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
    decisionNote: typeof raw.decisionNote === "string" ? raw.decisionNote : "",
  };
}

export async function submitAiQuotaRequest(
  store: AppAuthStore,
  input: { requestedBillableTokens: number; reason: string },
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const session = store.get();
  if (!session?.token) throw new Error("请先登录账号后再发起申请。");

  const baseUrl = resolveTibetApiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/api/ai/gateway/quota-request`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(input),
  });
  const envelope = await response.json() as QuotaEnvelope;
  if (envelope.code !== 200) {
    throw new Error(envelope.message || "申请提交失败，请稍后重试。");
  }
}
