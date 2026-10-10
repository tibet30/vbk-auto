/**
 * getImageInfo payload 解析（纯函数，便于单元测试）：
 *   - parseCtripImageInfoPayload：根 ResponseStatus.Ack 必须是 Success，
 *     否则抛中文错误；body 不是数组时返回空 items（不抛错，让 UI 显示「未取到」）。
 *   - parseImageInfoEntry：把单条 entry 解析为 CtripLibraryImageInfo；
 *   - 配套 helpers：positiveInteger / trimmedString / pickScore / pickVariantUrl
 *     等；只在模块内部使用，不外漏。
 */

import type {
  CtripImageInfoResponse,
  CtripLibraryImageInfo,
  CtripImageUrlVariant,
} from "./types.js";

export function parseCtripImageInfoPayload(payload: unknown, httpStatus = 200): CtripImageInfoResponse {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`携程图库图片查询业务失败：${failureReason(responseStatus)}`);
  }
  const body = Array.isArray(root?.body) ? root.body : [];
  const items: CtripLibraryImageInfo[] = [];
  for (const entry of body) {
    const parsed = parseImageInfoEntry(entry);
    if (parsed) items.push(parsed);
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), items };
}

function parseImageInfoEntry(entry: unknown): CtripLibraryImageInfo | null {
  const record = asRecord(entry);
  if (!record) return null;
  const imageId = positiveInteger(record.imageId);
  const poiId = positiveInteger(record.poiId);
  const poiName = trimmedString(record.poiName);
  const originalUrl = trimmedString(record.originalPath);
  const fileName = trimmedString(record.fileName);
  const districtName = trimmedString(record.districtName);
  const countryName = trimmedString(record.countryName);
  const width = positiveInteger(record.width);
  const height = positiveInteger(record.height);
  const resolution = width !== null && height !== null ? `${width}*${height}` : null;
  const score = pickScore(record);
  const imageUrls: CtripImageUrlVariant[] = [];
  const rawUrls = Array.isArray(record.imageUrls) ? record.imageUrls : [];
  for (const raw of rawUrls) {
    const urlRecord = asRecord(raw);
    const url = trimmedString(urlRecord?.url);
    if (!url) continue;
    imageUrls.push({
      url,
      width: positiveInteger(urlRecord?.width),
      height: positiveInteger(urlRecord?.height),
      type: trimmedString(urlRecord?.type),
    });
  }
  const thumbnailUrl = pickVariantUrl(imageUrls, 200, 200) ?? originalUrl;
  const previewUrl = pickVariantUrl(imageUrls, 500, 500) ?? originalUrl;
  if (!imageId && !poiName && !originalUrl && imageUrls.length === 0) {
    // 完全空对象：忽略。
    return null;
  }
  return {
    imageId,
    poiId,
    poiName,
    thumbnailUrl,
    previewUrl,
    originalUrl,
    resolution,
    score,
    fileName,
    districtName,
    countryName,
    imageUrls,
  };
}

function pickVariantUrl(urls: CtripImageUrlVariant[], width: number, height: number): string | null {
  for (const variant of urls) {
    if (variant.width === width && variant.height === height && variant.url) return variant.url;
  }
  // 兜底：大小相近即算（允许 ±10% 误差，防御 CDN 改尺寸）。
  for (const variant of urls) {
    if (variant.width === null || variant.height === null) continue;
    const dw = Math.abs((variant.width - width) / width);
    const dh = Math.abs((variant.height - height) / height);
    if (dw <= 0.1 && dh <= 0.1 && variant.url) return variant.url;
  }
  return null;
}

function pickScore(record: Record<string, unknown>): number | null {
  const note = record.noteImgScore;
  if (typeof note === "number" && Number.isFinite(note)) return note;
  if (typeof note === "string") {
    const parsed = Number(note);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ai = record.tourImgAiScore;
  if (typeof ai === "number" && Number.isFinite(ai)) return ai;
  if (typeof ai === "string") {
    const parsed = Number(ai);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function failureReason(status: Record<string, unknown> | null): string {
  const errors = Array.isArray(status?.Errors) ? status?.Errors : [];
  const first = asRecord(errors[0]);
  const reason = first?.Message ?? first?.message ?? first?.Code ?? status?.Ack ?? "ResponseStatus 未确认成功";
  return String(reason).replace(/[\r\n\t]/g, " ").slice(0, 300);
}