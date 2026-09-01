/**
 * 产品图文封面直绑：第一步已经选定携程图库 imageId 后，直接调用 VBK 官方
 * bindProductImage 接口，不再打开图库弹窗并重新按 POI 搜索。
 */

import { delay } from "../utils.js";
import {
  vbkSessionRequest,
  type VbkSessionRequestBrowser,
  type VbkSessionRequestResult,
} from "../../../infrastructure/vbk-session-request.js";

const BIND_PRODUCT_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20698/bindProductImage.json";
const SEARCH_PRODUCT_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20698/searchProductImage.json";
const COVER_IMAGE_TYPE_ID = 2;
const ATTRACTION_IMAGE_TYPE_ID = 4;

interface ProductImageRecord {
  imageId?: unknown;
  imageInfo?: ProductImageRecord;
  accompanyTourInfo?: { imageTypeId?: unknown };
}

interface CoverBindOptions {
  confirmationAttempts?: number;
  confirmationIntervalMs?: number;
}

export function buildCoverBindRequest(productId: number, imageId: number) {
  assertPositiveInteger(productId, "VBK 产品 ID");
  assertPositiveInteger(imageId, "封面 imageId");
  return {
    productId,
    productImages: [{
      imageId,
      accompanyTourInfo: {
        imageTypeId: COVER_IMAGE_TYPE_ID,
        slideShowType: 1,
      },
    }],
    isCover: true,
  };
}

export function buildImageTypeBindRequest(productId: number, imageId: number, imageTypeId: number) {
  assertPositiveInteger(productId, "VBK 产品 ID");
  assertPositiveInteger(imageId, "图片 imageId");
  assertPositiveInteger(imageTypeId, "图片类型 imageTypeId");
  return {
    productId,
    productImages: [{
      imageId,
      accompanyTourInfo: { imageTypeId, slideShowType: 2 },
    }],
    isCover: false,
  };
}

export function readProductIdFromVbkUrl(url: string): number {
  let productId = 0;
  try {
    const parsed = new URL(url);
    productId = Number(parsed.searchParams.get("productId") ?? parsed.searchParams.get("productid"));
  } catch {
    // 统一走下面的可读业务错误。
  }
  assertPositiveInteger(productId, "VBK 产品 ID");
  return productId;
}

export function responseHasBoundCover(payload: unknown, imageId: number): boolean {
  return responseHasImageType(payload, imageId, COVER_IMAGE_TYPE_ID);
}

function responseHasImageType(payload: unknown, imageId: number, imageTypeId: number): boolean {
  const record = asRecord(payload);
  const images = Array.isArray(record?.productImages) ? record.productImages : [];
  return images.some((entry) => {
    const outer = asRecord(entry) as ProductImageRecord | null;
    const image = asRecord(outer?.imageInfo) as ProductImageRecord | null ?? outer;
    return Number(image?.imageId) === imageId
      && Number(image?.accompanyTourInfo?.imageTypeId) === imageTypeId;
  });
}

export async function bindCtripLibraryCoverViaApi(
  page: VbkSessionRequestBrowser & { url(): string },
  imageId: number,
  productIdOrOptions?: number | CoverBindOptions,
  fallbackOptions: CoverBindOptions = {},
): Promise<{ reused: boolean; productId: number; imageId: number }> {
  assertPositiveInteger(imageId, "封面 imageId");
  const productId = typeof productIdOrOptions === "number"
    ? productIdOrOptions
    : readProductIdFromVbkUrl(page.url());
  assertPositiveInteger(productId, "VBK 产品 ID");
  const options = typeof productIdOrOptions === "number"
    ? fallbackOptions
    : productIdOrOptions ?? {};
  const existingResult = await searchProductImages(page, productId);
  assertBusinessSuccess(existingResult, "确认现有产品封面", false);
  const existingImages = productImageInfos(existingResult.payload);
  if (responseHasBoundCover(existingResult.payload, imageId)) {
    return { reused: true, productId, imageId };
  }

  // 只有 imageTypeId=2 明确表示“当前产品封面”。imageTypeId=0 仅表示
  // 未分类，无法推断其业务类型，必须保持不动；否则会误改酒店、餐饮等素材。
  const oldCovers = existingImages.filter((image) =>
    Number(image.imageId) !== imageId
    && Number(image.accompanyTourInfo?.imageTypeId) === COVER_IMAGE_TYPE_ID,
  );
  if (oldCovers.length > 1) {
    throw new Error("更换封面失败：远端存在多个当前封面，无法安全确定需要归类的旧封面。请先在 VBK 处理重复封面。");
  }
  const oldCover = oldCovers[0];
  let reclassifiedOldCoverId: number | undefined;
  if (oldCover) {
    const oldCoverId = Number(oldCover.imageId);
    if (!Number.isInteger(oldCoverId) || oldCoverId <= 0) {
      throw new Error("更换封面失败：远端当前封面缺少合法 imageId，已停止写入。");
    }
    const reclassifyResult = await request(page, {
      endpoint: BIND_PRODUCT_IMAGE_ENDPOINT,
      body: buildImageTypeBindRequest(productId, oldCoverId, ATTRACTION_IMAGE_TYPE_ID),
      errorLabel: "归类旧产品封面",
    });
    assertBusinessSuccess(reclassifyResult, "归类旧产品封面", true);
    await confirmImageType(
      page,
      productId,
      oldCoverId,
      ATTRACTION_IMAGE_TYPE_ID,
      "归类旧产品封面",
      options,
    );
    reclassifiedOldCoverId = oldCoverId;
  }

  const bindResult = await request(page, {
    endpoint: BIND_PRODUCT_IMAGE_ENDPOINT,
    body: buildCoverBindRequest(productId, imageId),
    errorLabel: "直接设置产品封面",
  });
  assertBusinessSuccess(bindResult, "直接设置产品封面", true);

  const attempts = positiveAttemptCount(options.confirmationAttempts, 10);
  const intervalMs = nonNegativeDelay(options.confirmationIntervalMs, 500);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const searchResult = await searchProductImages(page, productId);
    assertBusinessSuccess(searchResult, "确认产品封面", false);
    if (responseHasBoundCover(searchResult.payload, imageId)
      && (reclassifiedOldCoverId === undefined
        || responseHasImageType(searchResult.payload, reclassifiedOldCoverId, ATTRACTION_IMAGE_TYPE_ID))) {
      return { reused: false, productId, imageId };
    }
    if (attempt < attempts - 1 && intervalMs > 0) await delay(intervalMs);
  }
  if (reclassifiedOldCoverId !== undefined) {
    throw new Error(
      `封面接口已返回成功，但回读未同时确认新封面 imageId=${imageId} 与旧图 imageId=${reclassifiedOldCoverId} 的最终类型。`,
    );
  }
  throw new Error(`封面接口已返回成功，但回读未确认 imageId=${imageId} 已设置为产品封面。`);
}

async function confirmImageType(
  page: VbkSessionRequestBrowser,
  productId: number,
  imageId: number,
  imageTypeId: number,
  label: string,
  options: CoverBindOptions,
): Promise<void> {
  const attempts = positiveAttemptCount(options.confirmationAttempts, 10);
  const intervalMs = nonNegativeDelay(options.confirmationIntervalMs, 500);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const searchResult = await searchProductImages(page, productId);
    assertBusinessSuccess(searchResult, label, false);
    if (responseHasImageType(searchResult.payload, imageId, imageTypeId)) return;
    if (attempt < attempts - 1 && intervalMs > 0) await delay(intervalMs);
  }
  throw new Error(`${label}接口已返回成功，但回读未确认 imageId=${imageId} 的图片类型为 ${imageTypeId}。`);
}

function productImageInfos(payload: unknown): ProductImageRecord[] {
  const record = asRecord(payload);
  const images = Array.isArray(record?.productImages) ? record.productImages : [];
  return images.flatMap((entry) => {
    const outer = asRecord(entry) as ProductImageRecord | null;
    const image = asRecord(outer?.imageInfo) as ProductImageRecord | null ?? outer;
    return image ? [image] : [];
  });
}

async function searchProductImages(
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

async function request(
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

function assertBusinessSuccess(
  result: VbkSessionRequestResult,
  label: string,
  requireSuccess: boolean,
): void {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label}失败：HTTP ${result.status}`);
  }
  const payload = asRecord(result.payload);
  const ack = String(asRecord(payload?.ResponseStatus)?.Ack ?? "");
  if (ack === "Failure" || ack === "Warning") {
    throw new Error(`${label}失败：Ack=${ack}`);
  }
  if (requireSuccess && payload?.success !== true) {
    const message = typeof payload?.message === "string" ? `：${payload.message}` : "";
    throw new Error(`${label}失败：接口未返回 success=true${message}`);
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是正整数。`);
}

function positiveAttemptCount(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

export {
  ATTRACTION_IMAGE_TYPE_ID,
  BIND_PRODUCT_IMAGE_ENDPOINT,
  COVER_IMAGE_TYPE_ID,
  SEARCH_PRODUCT_IMAGE_ENDPOINT,
};
