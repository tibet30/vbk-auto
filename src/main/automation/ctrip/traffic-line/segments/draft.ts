/**
 * 子产品资源段 SOA 调用层：
 *   - getSegments / saveSegment / saveDepartureCities / publishSegmentModule / createProductDraft；
 *   - resolveTrafficLineModifyUser + trafficLineModifyUserFromState：取 VBK 会话当前操作账号。
 *
 * publishSegmentModule 超时兼容：
 *   - 超时不能猜测服务端是否已接受写入；
 *   - 仅当 publishedSegmentReadbackIsComplete（草稿已消耗 + 正式资源边界完整）
 *     时才把超时视为已落库。
 */

import { getVbkInitialState, postTrafficLineSoa, type JsonRecord, type TrafficLinePage } from "../client.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";
import { record, text } from "../client.js";
import { publishedSegmentReadbackIsComplete } from "./readback.js";
import { verifySegmentBoundaries } from "./boundaries.js";

type City = JsonRecord;

export async function getSegments(page: TrafficLinePage, productId: string): Promise<JsonRecord> {
  return postTrafficLineSoa(page, "15638", "getSegments", { productId }, "读取子产品资源段");
}

export async function saveSegment(page: TrafficLinePage, segment: JsonRecord): Promise<void> {
  await postTrafficLineSoa(page, "15638", "saveSegment", { segment }, "保存子产品资源段");
}

export async function saveDepartureCities(page: TrafficLinePage, productId: string, cities: City[]): Promise<void> {
  await postTrafficLineSoa(page, "15638", "SaveSegmentCommonData", {
    segmentCommonData: { productId, departureCities: cities, isCityManage: "F" },
  }, "保存子产品多出发城市");
}

export async function publishSegmentModule(
  page: TrafficLinePage,
  productId: string,
  modifyUser: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  expectedCities: City[] = [],
): Promise<void> {
  try {
    await postTrafficLineSoa(page, "15638", "publishProductModules", {
      productId: Number(productId) || productId,
      module: "segment",
      modifyUser,
    }, "提交子产品资源模块");
  } catch (error) {
    if (!/BrowserView 执行超时|浏览器请求超时/.test(String(error))) throw error;
    // 超时时不能猜测服务端是否已接受写入，也不能立即重提。
    // 只有草稿已被消耗且正式资源边界完整时，才将本次视为已落库。
    const readback = await getSegments(page, productId);
    if (!publishedSegmentReadbackIsComplete(readback, variant, endpoints, expectedCities)) throw error;
  }
}

export async function ensureSegmentDraft(
  page: TrafficLinePage,
  productId: string,
  sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<JsonRecord> {
  // 新建子产品在创建 segment 草稿前没有 getSegments 权限；创建接口本身可安全重入。
  await postTrafficLineSoa(page, "15638", "createProductDraft", { productId, module: "segment" }, "创建子产品资源草稿");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const draft = await getSegments(page, productId);
      if (Array.isArray(record(draft.draftProductSegments)?.segments)) return draft;
      lastError = new Error("子产品资源草稿初始化后仍不可写。");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await sleep(attempt * 300);
  }
  throw lastError instanceof Error ? lastError : new Error("子产品资源草稿初始化后仍不可写。");
}

export async function resolveTrafficLineModifyUser(page: TrafficLinePage, productId: string): Promise<string> {
  const endpoint = `https://vbooking.ctrip.com/ivbk/vendor/TourDays?productid=${encodeURIComponent(productId)}&istab=1&from=vbk`;
  const state = await getVbkInitialState(page, endpoint, "读取子产品当前操作账号");
  return trafficLineModifyUserFromState(state);
}

export function trafficLineModifyUserFromState(state: JsonRecord): string {
  const user = record(record(state.userInfo)?.user);
  const modifyUser = text(user?.account) || text(user?.name);
  if (!modifyUser) throw new Error("子产品资源模块缺少当前会话操作账号，未提交资源，可安全重试。");
  return modifyUser;
}