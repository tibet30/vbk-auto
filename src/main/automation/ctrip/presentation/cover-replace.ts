/**
 * 换封面前的腾位逻辑。VBK 单个产品最多 20 张图，旧封面不再改成景点图占位，
 * 而是用官方页面同款 unbindProductImage 删除；产品已满且没有旧封面时，
 * 删除最后一张已确认类型的景点图，每次删除都要回读确认。
 */

import { delay } from "../utils.js";
import type { VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import {
  ATTRACTION_IMAGE_TYPE_ID,
  COVER_IMAGE_TYPE_ID,
  UNBIND_PRODUCT_IMAGE_ENDPOINT,
  assertBusinessSuccess,
  nonNegativeDelay,
  positiveAttemptCount,
  productImageEntries,
  productImageInfos,
  request,
  searchProductImages,
  type CoverBindOptions,
} from "./image-api.js";

export const MAX_PRODUCT_IMAGES = 20;

async function unbindProductImage(
  page: VbkSessionRequestBrowser,
  productId: number,
  target: { imageId: number; source: number },
  label: string,
  options: CoverBindOptions,
): Promise<void> {
  await options.beforeWrite?.();
  const result = await request(page, {
    endpoint: UNBIND_PRODUCT_IMAGE_ENDPOINT,
    body: { productId, productImages: [target] },
    errorLabel: label,
  });
  assertBusinessSuccess(result, label, true);
  const attempts = positiveAttemptCount(options.confirmationAttempts, 10);
  const intervalMs = nonNegativeDelay(options.confirmationIntervalMs, 500);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const searchResult = await searchProductImages(page, productId);
    assertBusinessSuccess(searchResult, label, false);
    if (!productImageInfos(searchResult.payload).some((image) => Number(image.imageId) === target.imageId)) return;
    if (attempt < attempts - 1 && intervalMs > 0) await delay(intervalMs);
  }
  throw new Error(`${label}接口已返回成功，但回读未确认 imageId=${target.imageId} 已删除。`);
}

/** 删除旧封面；产品仍无空位时再删一张景点图。返回被删除的 imageId，供日志与恢复使用。 */
export async function makeRoomForCover(
  page: VbkSessionRequestBrowser,
  productId: number,
  newCoverId: number,
  searchPayload: unknown,
  options: CoverBindOptions,
): Promise<{ removedCoverId?: number; removedAttractionId?: number }> {
  const entries = productImageEntries(searchPayload);
  const oldCovers = entries.filter(({ image }) => Number(image.imageId) !== newCoverId
    && Number(image.accompanyTourInfo?.imageTypeId) === COVER_IMAGE_TYPE_ID);
  // 只有 imageTypeId=2 明确表示“当前产品封面”；无类型图片不动，避免误删酒店、餐饮素材。
  if (oldCovers.length > 1) {
    throw new Error("更换封面失败：远端存在多个当前封面，无法安全确定需要删除的旧封面。请先在 VBK 处理重复封面。");
  }
  const result: { removedCoverId?: number; removedAttractionId?: number } = {};
  let remaining = entries.length;
  const oldCover = oldCovers[0];
  if (oldCover) {
    const oldCoverId = Number(oldCover.image.imageId);
    if (!Number.isInteger(oldCoverId) || oldCoverId <= 0) {
      throw new Error("更换封面失败：远端当前封面缺少合法 imageId，已停止写入。");
    }
    await unbindProductImage(page, productId, { imageId: oldCoverId, source: oldCover.source }, "删除旧产品封面", options);
    result.removedCoverId = oldCoverId;
    remaining -= 1;
  }
  const alreadyOnProduct = entries.some(({ image }) => Number(image.imageId) === newCoverId);
  if (alreadyOnProduct || remaining < MAX_PRODUCT_IMAGES) return result;

  const spare = [...entries].reverse().find(({ image }) => Number(image.imageId) !== newCoverId
    && Number(image.accompanyTourInfo?.imageTypeId) === ATTRACTION_IMAGE_TYPE_ID
    && Number.isInteger(Number(image.imageId)) && Number(image.imageId) > 0);
  if (!spare) {
    throw new Error(`更换封面失败：产品图片已满 ${MAX_PRODUCT_IMAGES} 张，且没有可确认类型的景点图可删除；请先在 VBK 清理图片。`);
  }
  const spareId = Number(spare.image.imageId);
  await unbindProductImage(page, productId, { imageId: spareId, source: spare.source }, "删除多余景点图", options);
  result.removedAttractionId = spareId;
  return result;
}
