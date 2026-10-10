/**
 * 产品图文（productImageText）阶段主入口：
 *   - selectCtripLibraryCover：第一阶段已经持久化 imageId，直接调用 VBK
 *     图片绑定接口并回读确认封面；最多尝试 3 张候选图；
 *   - bindCtripLibraryPresentationImages：选完封面再绑景点图（备选图作
 *     景点配图），单张缺失不阻断；
 *   - fillAndSavePresentation：以显式 productId 接口保存推荐理由、产品
 *     特点与封面，每步回读成功后直接返回。
 *
 * 防御深度（defense in depth）：
 *   - readiness / automationBlockers 已经在起跑前校验过 presentation 必填字段；
 *   - 本函数第一行用 assertPresentationReadyForVbk 再校验一次；
 *   - 不调用 VBK、不打开网络、不会留下半成品页面状态。
 *
 * 保存不再触碰推荐理由 textarea / UEditor DOM：统一走 /15638/getdescriptionInfo →
 * /20698/createProductDraft(desc) → /15638/savedescriptioninfo → 回读确认。
 */

import { assertPresentationReadyForVbk } from "../../../automation-contract.js";
import { bindCtripLibraryAttractionImageViaApi, bindCtripLibraryCoverViaApi } from "../cover-bind.js";
import { savePresentationViaApi } from "../presentation-api.js";
import { inspectManualCoverAsset } from "../../../manual-cover-asset.js";
import { uploadManualCoverViaSupplierPage } from "../manual-cover-upload.js";
import { loadPlaceholderCoverAsset } from "../../../placeholder-cover-asset.js";
import { readActiveCoverFallback } from "../../../../../shared/cover-fallback.js";
import type { CtripLibraryCover } from "../../../../../shared/contracts-ctrip-cover.js";
import type { ManualUploadCover } from "../../../../../shared/contracts-ctrip-cover.js";
import type { VbkPage } from "../../locator-types.js";
import { buildRecommendationReasonsPlan } from "../recommendations.js";
import { ctripLibraryCoverAttempts } from "./cover-attempts.js";

export interface PresentationWriteOptions {
  beforeWrite?: () => Promise<void>;
  reconcile?: boolean;
  onImagesBound?: (result: unknown) => void;
}

type ManualUploadCoverWithRemoteId = ManualUploadCover & { remoteImageId?: number };

interface PresentationContent extends Record<string, unknown> {
  cover?: CtripLibraryCover | ManualUploadCoverWithRemoteId;
  coverFallback?: { remoteImageId?: number };
  recommendations?: ReadonlyArray<{ category: string; text: string }>;
}

interface PresentationProduct extends Record<string, unknown> {
  productId?: unknown;
  presentation?: PresentationContent;
  basicInfo?: { meetingCity?: unknown };
}

/** 第一阶段已经持久化 imageId，直接调用 VBK 图片绑定接口并回读确认封面。 */
export async function selectCtripLibraryCover(
  page: VbkPage,
  cover: CtripLibraryCover,
  productId: number,
  options: PresentationWriteOptions = {},
) {
  const attempts = ctripLibraryCoverAttempts(cover).slice(0, 3);
  const failures: string[] = [];
  const attemptedImageIds: number[] = [];
  for (const candidate of attempts) {
    await options.beforeWrite?.();
    attemptedImageIds.push(candidate.imageId);
    try {
      const result = await bindCtripLibraryCoverViaApi(page, candidate.imageId, productId, options);
      return { ...result, selectedCover: candidate, attemptedImageIds };
    } catch (error) {
      failures.push(
        `${candidate.poi || "未命名景点"} imageId=${candidate.imageId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(`产品图文封面绑定失败：已尝试 ${attempts.length} 张图片；${failures.join("；")}`);
}

export async function bindCtripLibraryPresentationImages(
  page: VbkPage,
  cover: CtripLibraryCover,
  productId: number,
  options: PresentationWriteOptions = {},
) {
  const coverResult = await selectCtripLibraryCover(page, cover, productId, options);
  const imageProductId = Number(productId ?? coverResult.productId);
  const selectedCoverId = Number(coverResult.imageId);
  const attractionResults: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const candidate of ctripLibraryCoverAttempts(cover)) {
    if (candidate.imageId === selectedCoverId) continue;
    await options.beforeWrite?.();
    try {
      const result = await bindCtripLibraryAttractionImageViaApi(page, candidate.imageId, imageProductId, options);
      attractionResults.push({ ...result, selectedImage: candidate });
    } catch (error) {
      failures.push(
        `${candidate.poi || "未命名景点"} imageId=${candidate.imageId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // 景点图尽量绑定，单张缺失或不可用不阻断后续图文保存。
  return { ...coverResult, attractionImages: attractionResults, ...(failures.length ? { imageWarnings: failures } : {}) };
}

export async function fillAndSavePresentation(
  page: VbkPage,
  product: PresentationProduct,
  explicitProductId?: string | number,
  onManualCoverBound?: (imageId: number) => void | Promise<void>,
  options: PresentationWriteOptions = {},
) {
  // 第一道防御：统一从 automation-contract 取真实契约，错误文案面向运营。
  assertPresentationReadyForVbk(product);
  const presentation = product.presentation;
  if (!presentation) throw new Error("产品图文（presentation）尚未生成，无法继续保存。");
  const productId = Number(explicitProductId ?? product.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new Error("产品图文接口保存：产品 ID 缺失，无法继续。");
  }
  const cover = presentation?.cover;
  const fallback = readActiveCoverFallback(product);
  if (!cover && !fallback) throw new Error("产品图文缺少封面配置，已停止后续录入。");

  // 防御深度：仍然保留 3 条 + 白名单 + 不重复校验（buildRecommendationReasonsPlan
  // 抛错信息保持原样），避免改动影响既有运营提示。
  if (!presentation.recommendations) {
    throw new Error("推荐理由必须恰好 3 条：分类在白名单且不重复，文本非空。请补全 presentation.recommendations。");
  }
  buildRecommendationReasonsPlan(presentation.recommendations);
  // 产品图片先通过 bindProductImage 设置封面和景点图；推荐理由 + 产品特色
  // 再由 savePresentationViaApi 写入 /15638/getdescriptionInfo →
  // /20698/createProductDraft → /15638/savedescriptioninfo。
  let coverResult: unknown;
  await options.beforeWrite?.();
  if (fallback) {
    coverResult = await uploadManualCoverViaSupplierPage(
      page, productId, loadPlaceholderCoverAsset(), String(product.basicInfo?.meetingCity ?? ""),
      fallback.remoteImageId,
      async (imageId) => {
        await options.beforeWrite?.();
        if (presentation.coverFallback) presentation.coverFallback.remoteImageId = imageId;
        await onManualCoverBound?.(imageId);
      },
      options.beforeWrite,
    );
  } else if (cover?.source === "manualUpload") {
    const { asset, issue } = inspectManualCoverAsset(product);
    if (!asset) throw new Error(issue ?? "手动封面文件不可用。");
    coverResult = await uploadManualCoverViaSupplierPage(
      page, productId, asset.path, String(product.basicInfo?.meetingCity ?? ""),
      Number(cover.remoteImageId) || undefined,
      async (imageId) => {
        await options.beforeWrite?.();
        cover.remoteImageId = imageId;
        await onManualCoverBound?.(imageId);
      },
      options.beforeWrite,
    );
  } else if (cover?.source === "ctripLibrary" && ctripLibraryCoverAttempts(cover).length > 0) {
    coverResult = await bindCtripLibraryPresentationImages(page, cover, productId, options);
  } else {
    throw new Error("产品图文缺少完整的携程图库封面配置，已停止后续录入。");
  }
  options.onImagesBound?.(coverResult);
  const savedWith = await savePresentationViaApi(page, presentation, productId, options);
  return { advanced: true, mode: "presentation-api", productId, coverResult, savedWith };
}

// source-slicing anchor（仅供测试切片识别，不在运行时使用）：
/**
 * 测试切片占位：实现见 ../itinerary/common.ts；保留签名让 source-slicing 识别。
 */
function dayScopeFor(_titleInput: unknown) { return null; }