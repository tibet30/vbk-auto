/** VBK 产品图片接口的共用原语：请求、查询、业务成功校验、回读解析。 */

import {
  vbkSessionRequest,
  type VbkSessionRequestBrowser,
  type VbkSessionRequestResult,
} from "../../../infrastructure/vbk-session-request.js";
import { describeVbkFailureDetail } from "../../../infrastructure/vbk-response-error.js";

export const BIND_PRODUCT_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20698/bindProductImage.json";
export const UNBIND_PRODUCT_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20698/unbindProductImage.json";
export const SEARCH_PRODUCT_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20698/searchProductImage.json";
export const COVER_IMAGE_TYPE_ID = 2;
export const ATTRACTION_IMAGE_TYPE_ID = 4;

export interface ProductImageRecord {
  imageId?: unknown;
  fileName?: unknown;
  imageInfo?: ProductImageRecord;
  accompanyTourInfo?: { imageTypeId?: unknown };
}

export interface CoverBindOptions {
  beforeWrite?: () => Promise<void>;
  confirmationAttempts?: number;
  confirmationIntervalMs?: number;
}

/** 解包 searchProductImage 的条目；source 在外层，unbindProductImage 需要原样带回。 */
export function productImageEntries(payload: unknown): Array<{ image: ProductImageRecord; source: number }> {
  const record = asRecord(payload);
  const images = Array.isArray(record?.productImages) ? record.productImages : [];
  return images.flatMap((entry) => {
    const outer = asRecord(entry) as (ProductImageRecord & { source?: unknown }) | null;
    const image = asRecord(outer?.imageInfo) as ProductImageRecord | null ?? outer;
    return image ? [{ image, source: Number.isInteger(outer?.source) ? Number(outer?.source) : 0 }] : [];
  });
}

export function productImageInfos(payload: unknown): ProductImageRecord[] {
  return productImageEntries(payload).map((entry) => entry.image);
}

export function responseHasImageType(payload: unknown, imageId: number, imageTypeId: number): boolean {
  return productImageInfos(payload).some((image) => Number(image.imageId) === imageId
    && Number(image.accompanyTourInfo?.imageTypeId) === imageTypeId);
}

export async function searchProductImages(
  page: VbkSessionRequestBrowser,
  productId: number,
): Promise<VbkSessionRequestResult> {
  return request(page, {
    endpoint: SEARCH_PRODUCT_IMAGE_ENDPOINT,
    body: {
      productId,
      removeUnauthorized: true,
      urlOptions: [{ width: 200, height: 200, quality: 0.9, type: "R" }],
    },
    errorLabel: "确认产品封面",
  });
}

export async function request(
  page: VbkSessionRequestBrowser,
  args: { endpoint: string; body: Record<string, unknown>; errorLabel: string },
): Promise<VbkSessionRequestResult> {
  return vbkSessionRequest(page, {
    ...args,
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    includeCidQuery: true,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: "https://vbooking.ctrip.com/",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
}

export function assertBusinessSuccess(
  result: VbkSessionRequestResult,
  label: string,
  requireSuccess: boolean,
): void {
  if (result.status < 200 || result.status >= 300) {
    const detail = describeVbkFailureDetail(result.payload);
    throw new Error(`${label}失败：HTTP ${result.status}${detail ? `；${detail}` : ""}`);
  }
  const payload = asRecord(result.payload);
  const ack = String(asRecord(payload?.ResponseStatus)?.Ack ?? "");
  if (ack === "Failure" || ack === "Warning") {
    const detail = describeVbkFailureDetail(payload);
    throw new Error(`${label}失败：Ack=${ack}${detail ? `；${detail}` : ""}`);
  }
  if (requireSuccess && payload?.success !== true) {
    const message = describeVbkFailureDetail(payload)
      || (typeof payload?.message === "string" ? payload.message : "");
    throw new Error(`${label}失败：接口未返回 success=true${message ? `：${message}` : ""}`);
  }
}

export function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是正整数。`);
}

export function positiveAttemptCount(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function nonNegativeDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}
