/**
 * suggestPoi payload 解析：
 *   - parsePoiSuggestPayload：根 ResponseStatus.Ack 必须是 Success，否则抛错；
 *     提取 poiList → pickBestPoi → 组装 PoiSuggestDetailResult。
 *
 * 与 match.ts 互不耦合：parse 只取列表与 best，match 只看名字 / 地域 / 别名匹配。
 */

import type { PoiSuggestDetailResultWithRawPayload } from "../poi-suggest-detail.js";
import { buildPoiSuggestDetailResult } from "../poi-suggest-detail.js";
import type { PoiSuggestion } from "../../../shared/contracts.js";
import { pickBestPoi } from "./match.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function failureReason(status: Record<string, unknown> | null): string {
  const errors = Array.isArray(status?.Errors) ? status.Errors : [];
  const first = asRecord(errors[0]);
  const reason = first?.Message ?? first?.message ?? first?.Code ?? status?.Ack ?? "ResponseStatus 未确认成功";
  return String(reason).replace(/[\r\n\t]/g, " ").slice(0, 300);
}

export function parsePoiSuggestPayload(
  keyword: string,
  payload: unknown,
  httpStatus = 200,
  context?: { destinationCity?: string; province?: string },
): PoiSuggestDetailResultWithRawPayload {
  const body = asRecord(payload);
  const responseStatus = asRecord(body?.ResponseStatus);
  const ack = responseStatus?.Ack ?? null;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`VBK POI 查询业务失败：${failureReason(responseStatus)}`);
  }
  const data = asRecord(body?.data);
  const list = Array.isArray(body?.poiList) ? body.poiList : Array.isArray(data?.poiList) ? data.poiList : [];
  const best = pickBestPoi(keyword, { poiList: list }, context)
    ?? (!hasLocationContext(context) ? pickBestPoi(keyword, {
      // A few live responses put valid names/IDs behind locale-specific
      // metadata that makes the raw context filter undecidable. Re-run the
      // strict name matcher on the already-sanitised identity projection;
      // 带产品地域时禁止使用这条无地域投影，否则外地完全同名 POI 会绕过
      // destinationCity / province 过滤。
      poiList: list.map((item) => ({ localName: candidatePoiName(item), poiId: positiveIntegerValue(asRecord(item)?.poiId) })),
    }) : null);
  return buildPoiSuggestDetailResult({
    httpStatus,
    businessStatus: ack as string | number | boolean | null,
    best,
    payload,
    poiList: list,
  });
}

function hasLocationContext(context?: { destinationCity?: string; province?: string }): boolean {
  return Boolean(context?.destinationCity?.trim() || context?.province?.trim());
}

function candidatePoiName(value: unknown): string {
  const poi = asRecord(value);
  // 部分 VBK 会话会把 poiName 本地化成英文，同时保留中文 localName。
  // 规划关键词是中文，优先使用 localName；旧响应仍回退 poiName/name。
  return String(poi?.localName ?? poi?.poiName ?? poi?.name ?? "").trim();
}