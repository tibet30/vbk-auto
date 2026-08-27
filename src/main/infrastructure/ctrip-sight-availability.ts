import type { PoiSuggestBrowser } from "./poi-suggest.js";

const SIGHT_ONLINE_PAGE_ENDPOINT = "https://m.ctrip.com/restapi/soa2/18109/json/getSightOnlinePage";
const AVAILABILITY_CACHE_TTL_MS = 5 * 60_000;
const AVAILABILITY_BATCH_CONCURRENCY = 5;
const AVAILABILITY_RETRY_LIMIT = 2;
const availabilityCache = new Map<number, { value: CtripSightAvailability; expiresAt: number }>();

export interface CtripSightAvailability {
  status: "available" | "suspended";
  openStatus: string;
  latelyOpenTime: string | null;
}

/**
 * 携程攻略景点详情的营业状态权威源。`suggestPoi` 仅负责名称/ID 匹配，
 * 不承诺返回营业状态；这里按其返回的 poiId 单独核验。
 */
export async function getCtripSightAvailability(
  browser: PoiSuggestBrowser | undefined,
  poiId: number,
): Promise<CtripSightAvailability> {
  if (!Number.isInteger(poiId) || poiId <= 0) throw new Error("POI 营业状态核验缺少有效 poiId");
  const cached = availabilityCache.get(poiId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getCtripSightAvailabilityUncached(browser, poiId);
  availabilityCache.set(poiId, { value, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
  return value;
}

/**
 * 详情接口仅接受一个 poiId；这里以有限并发把一组独立查询聚合起来，
 * 避免完整行程复核时串行等待或对携程详情服务突发请求。
 */
export async function getCtripSightAvailabilities(
  browser: PoiSuggestBrowser | undefined,
  poiIds: readonly number[],
): Promise<Map<number, CtripSightAvailability>> {
  const ids = [...new Set(poiIds.filter((poiId) => Number.isInteger(poiId) && poiId > 0))];
  const result = new Map<number, CtripSightAvailability>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < ids.length) {
      const poiId = ids[nextIndex++]!;
      result.set(poiId, await getCtripSightAvailability(browser, poiId));
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
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`携程景点营业状态查询失败：poiId=${poiId}`);
}

async function requestCtripSightAvailability(browser: PoiSuggestBrowser | undefined, poiId: number): Promise<CtripSightAvailability> {
  void browser;
  // 这是携程攻略公开详情接口，不依赖 VBK 登录态。必须从主进程直连；若放进
  // VBK 页面 evaluate，会被 vbooking.ctrip.com → m.ctrip.com 的跨域策略拦截。
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
  if (!response.ok) throw new Error(`携程景点营业状态查询失败：HTTP ${response.status}，poiId=${poiId}`);
  const payload = record(await response.json());
  if (!payload || payload.result !== 0) throw new Error(`携程景点营业状态查询失败：poiId=${poiId}`);
  const openInfo = record(payload.openInfo) ?? {};
  const openStatus = text(openInfo.openStatus);
  return {
    status: isSuspended(openStatus) ? "suspended" : "available",
    openStatus,
    latelyOpenTime: text(openInfo.latelyOpenTime) || null,
  };
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
