import { clampRetryAfterSeconds, parseRetryAfterSeconds } from "../../shared/retry-after.js";
import type { PoiSuggestBrowser } from "./poi-suggest.js";

const SIGHT_ONLINE_PAGE_ENDPOINT = "https://m.ctrip.com/restapi/soa2/18109/json/getSightOnlinePage";
const AVAILABILITY_CACHE_TTL_MS = 5 * 60_000;
const PERSISTED_AVAILABILITY_CACHE_TTL_MS = 24 * 60 * 60_000;
const AVAILABILITY_BATCH_CONCURRENCY = 1;
const AVAILABILITY_RETRY_LIMIT = 2;
const REQUEST_INTERVAL_MS = 1_000;
const WHALE_GUARD_DEFAULT_COOLDOWN_MS = 15_000;
const WHALE_GUARD_MAX_WAIT_MS = 120_000;
const availabilityCache = new Map<number, { value: CtripSightAvailability; expiresAt: number }>();
let whaleGuardBlockedUntil = 0;
let requestTail: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

export interface CtripSightAvailability {
  status: "available" | "suspended";
  openStatus: string;
  latelyOpenTime: string | null;
}

/** 成功核验的持久化缓存。实现由 VbkDatabase 提供，避免基础设施层耦合数据库实现。 */
export interface CtripSightAvailabilityCache {
  getCachedCtripPoiAvailability(poiId: number): {
    status: "available" | "suspended";
    openStatus: string;
    latelyOpenTime: string | null;
    verifiedAt: string;
  } | undefined;
  saveCachedCtripPoiAvailability(entry: {
    poiId: number;
    status: "available" | "suspended";
    openStatus: string;
    latelyOpenTime: string | null;
    verifiedAt: string;
  }): void;
}

interface PersistedAvailability {
  status: "available" | "suspended";
  openStatus: string;
  latelyOpenTime: string | null;
  verifiedAt: string;
}

/**
 * 携程攻略景点详情的营业状态权威源。`suggestPoi` 仅负责名称/ID 匹配，
 * 不承诺返回营业状态；这里按其返回的 poiId 单独核验。
 */
export async function getCtripSightAvailability(
  browser: PoiSuggestBrowser | undefined,
  poiId: number,
  cache?: CtripSightAvailabilityCache,
): Promise<CtripSightAvailability> {
  if (!Number.isInteger(poiId) || poiId <= 0) throw new Error("POI 营业状态核验缺少有效 poiId");
  const cached = availabilityCache.get(poiId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const persisted: PersistedAvailability | undefined = cache?.getCachedCtripPoiAvailability(poiId);
  if (persisted && Date.parse(persisted.verifiedAt) > Date.now() - PERSISTED_AVAILABILITY_CACHE_TTL_MS) {
    const value = toAvailability(persisted);
    availabilityCache.set(poiId, { value, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
    return value;
  }
  const value = await getCtripSightAvailabilityUncached(browser, poiId);
  availabilityCache.set(poiId, { value, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
  cache?.saveCachedCtripPoiAvailability({ poiId, ...value, verifiedAt: new Date().toISOString() });
  return value;
}

/**
 * 详情接口仅接受一个 poiId；这里以有限并发把一组独立查询聚合起来，
 * 避免完整行程复核时串行等待或对携程详情服务突发请求。
 */
export async function getCtripSightAvailabilities(
  browser: PoiSuggestBrowser | undefined,
  poiIds: readonly number[],
  cache?: CtripSightAvailabilityCache,
): Promise<Map<number, CtripSightAvailability>> {
  const ids = [...new Set(poiIds.filter((poiId) => Number.isInteger(poiId) && poiId > 0))];
  const result = new Map<number, CtripSightAvailability>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < ids.length) {
      const poiId = ids[nextIndex++]!;
      result.set(poiId, await getCtripSightAvailability(browser, poiId, cache));
    }
  };
  await Promise.all(Array.from({ length: Math.min(AVAILABILITY_BATCH_CONCURRENCY, ids.length) }, worker));
  return result;
}

async function getCtripSightAvailabilityUncached(browser: PoiSuggestBrowser | undefined, poiId: number): Promise<CtripSightAvailability> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= AVAILABILITY_RETRY_LIMIT; attempt += 1) {
    try {
      return await requestCtripSightAvailability(browser, poiId);
    } catch (error) {
      lastError = error;
      if (isWhaleGuardBlock(error)) {
        const waitMs = Math.max(0, whaleGuardBlockedUntil - Date.now());
        if (waitMs > 0 && attempt < AVAILABILITY_RETRY_LIMIT) {
          await delay(Math.min(waitMs, WHALE_GUARD_MAX_WAIT_MS));
          continue;
        }
        break;
      }
      if (attempt < AVAILABILITY_RETRY_LIMIT) await delay(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`携程景点营业状态查询失败：poiId=${poiId}`);
}

async function requestCtripSightAvailability(browser: PoiSuggestBrowser | undefined, poiId: number): Promise<CtripSightAvailability> {
  void browser;
  // 这是携程攻略公开详情接口，不依赖 VBK 登录态。必须从主进程直连；若放进
  // VBK 页面 evaluate，会被 vbooking.ctrip.com → m.ctrip.com 的跨域策略拦截。
  return scheduleCtripSightRequest(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let response: Response;
    try {
      response = await fetch(SIGHT_ONLINE_PAGE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json;charset=UTF-8", "accept-language": "zh-CN,zh;q=0.9" },
        body: JSON.stringify({ head: { syscode: "999" }, poiId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const detail = response.status === 430 ? (await response.text()).slice(0, 120) : "";
      if (response.status === 430) {
        const headerSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
        const bodySeconds = parseRetryAfterSeconds(detail);
        const seconds = clampRetryAfterSeconds(headerSeconds ?? bodySeconds ?? WHALE_GUARD_DEFAULT_COOLDOWN_MS / 1_000);
        whaleGuardBlockedUntil = Date.now() + seconds * 1_000;
        throw new CtripSightAvailabilityError(430, `请 ${seconds} 秒后重试`);
      }
      throw new CtripSightAvailabilityError(response.status, `携程景点营业状态查询失败：HTTP ${response.status}，poiId=${poiId}${detail ? `，${detail}` : ""}`);
    }
    const payload = record(await response.json());
    if (!payload || payload.result !== 0) throw new Error(`携程景点营业状态查询失败：poiId=${poiId}`);
    const openInfo = record(payload.openInfo) ?? {};
    const openStatus = text(openInfo.openStatus);
    return {
      status: isSuspended(openStatus) ? "suspended" : "available",
      openStatus,
      latelyOpenTime: text(openInfo.latelyOpenTime) || null,
    };
  });
}

async function scheduleCtripSightRequest<T>(request: () => Promise<T>): Promise<T> {
  const previous = requestTail;
  let release!: () => void;
  requestTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await previous;
    // 明确有冷却时间时挂起等待，而不是立刻失败让模型空转重查。
    const cooldownMs = Math.max(0, whaleGuardBlockedUntil - Date.now());
    if (cooldownMs > 0) await delay(Math.min(cooldownMs, WHALE_GUARD_MAX_WAIT_MS));
    const waitMs = Math.max(0, lastRequestStartedAt + REQUEST_INTERVAL_MS - Date.now());
    if (waitMs > 0) await delay(waitMs);
    lastRequestStartedAt = Date.now();
    return await request();
  } finally {
    release();
  }
}

class CtripSightAvailabilityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isWhaleGuardBlock(error: unknown): boolean {
  return error instanceof CtripSightAvailabilityError && error.status === 430;
}

function toAvailability(entry: PersistedAvailability): CtripSightAvailability {
  return { status: entry.status, openStatus: entry.openStatus, latelyOpenTime: entry.latelyOpenTime };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSuspended(value: string): boolean {
  return /暂停营业|停止营业|永久关闭|已关闭|可能已关闭|temporarily\s+closed|permanently\s+closed/i.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
