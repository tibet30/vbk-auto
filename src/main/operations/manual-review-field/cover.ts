/**
 * presentation.cover 字段写入：
 *   - applyProductCover：ctripLibrary / manualUpload 二选一，缺 / 多必填项直接
 *     抛错，绝不写半成品；可选字段（thumbnailUrl / previewUrl / score / ...）
 *     仅保留「确实存在且合法」的值，避免 undefined / 空字符串 / 非法数字
 *     污染 product JSON；写完同步清掉 presentation.coverFallback；
 *   - 本函数**不**校验 manualUpload 的 fileId 是否在本地副本中存在——文件存在
 *     校验在主进程 IPC 路由里通过 cover:uploadManual + retainManualCoverFile
 *     完成；本函数保持纯函数特性便于测试。
 */

import type { ManualReviewFieldInput, ProductCover } from "../../../shared/contracts.js";
import { objectValue } from "./util.js";

export function applyProductCover(
  product: Record<string, unknown>,
  cover: ProductCover,
): Record<string, unknown> {
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) {
    throw new Error("封面写入项必须是合法对象。");
  }
  const poi = typeof cover.poi === "string" ? cover.poi.trim() : "";
  const description = typeof cover.description === "string" ? cover.description.trim() : "";
  const minQuality = typeof cover.minQuality === "number" && Number.isFinite(cover.minQuality)
    ? cover.minQuality
    : null;
  if (!poi) throw new Error("封面 POI 不能为空。");
  if (cover.source === "ctripLibrary") {
    // imageId / imageUrl 是携程图库封面「一张具体图片」的主键与展示 URL：
    // 缺其中任一字段都视为非法写入，直接抛错（与 shared CtripLibraryCover
    // 契约保持一致），不写半成品 cover。
    const rawImageId = (cover as { imageId?: unknown }).imageId;
    if (!Number.isInteger(rawImageId) || (rawImageId as number) <= 0) {
      throw new Error("携程图库封面缺少合法的 imageId（必须是正整数）。");
    }
    const imageId = rawImageId as number;
    const imageUrlRaw = typeof (cover as { imageUrl?: unknown }).imageUrl === "string"
      ? ((cover as { imageUrl: string }).imageUrl).trim()
      : "";
    if (!imageUrlRaw) {
      throw new Error("携程图库封面缺少 imageUrl。");
    }

    // 可选字段：仅保留「确实存在且合法」的值，避免把 undefined / 空字符串 /
    // 非法数字写入 product JSON 后污染后续 UI 渲染与 schema 二次校验。
    const coverRecord = cover as unknown as Record<string, unknown>;
    const thumbnailUrl = typeof coverRecord.thumbnailUrl === "string" ? coverRecord.thumbnailUrl.trim() : "";
    const previewUrl = typeof coverRecord.previewUrl === "string" ? coverRecord.previewUrl.trim() : "";
    const scoreRaw = coverRecord.score;
    const resolution = typeof coverRecord.resolution === "string" ? coverRecord.resolution.trim() : "";
    const poiIdRaw = coverRecord.poiId;
    const poiName = typeof coverRecord.poiName === "string" ? coverRecord.poiName.trim() : "";
    const selectedAt = typeof coverRecord.selectedAt === "string" ? coverRecord.selectedAt.trim() : "";

    const optionalFields: {
      thumbnailUrl?: string;
      previewUrl?: string;
      score?: number;
      resolution?: string;
      poiId?: number;
      poiName?: string;
      selectedAt?: string;
    } = {};
    if (thumbnailUrl) optionalFields.thumbnailUrl = thumbnailUrl;
    if (previewUrl) optionalFields.previewUrl = previewUrl;
    if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw)) {
      optionalFields.score = scoreRaw;
    }
    if (resolution) optionalFields.resolution = resolution;
    if (typeof poiIdRaw === "number" && Number.isInteger(poiIdRaw) && poiIdRaw > 0) {
      optionalFields.poiId = poiIdRaw;
    }
    if (poiName) optionalFields.poiName = poiName;
    if (selectedAt) optionalFields.selectedAt = selectedAt;

    const next = structuredClone(product) as Record<string, unknown>;
    const presentation = objectValue(next.presentation);
    presentation.cover = {
      source: "ctripLibrary",
      imageId,
      imageUrl: imageUrlRaw,
      poi,
      ...(description ? { description } : {}),
      ...(minQuality !== null && minQuality >= 0 && minQuality <= 5 ? { minQuality } : {}),
      ...optionalFields,
    } satisfies ProductCover;
    delete presentation.coverFallback;
    next.presentation = presentation;
    return next;
  }
  if (cover.source === "manualUpload") {
    if (!description) throw new Error("封面描述不能为空。");
    if (minQuality === null || minQuality < 0 || minQuality > 5) {
      throw new Error("封面最低质量分必须为 0~5 之间的数字。");
    }
    const fileId = typeof cover.fileId === "string" ? cover.fileId.trim() : "";
    const originalName = typeof cover.originalName === "string" ? cover.originalName.trim() : "";
    const mimeType = cover.mimeType;
    const sizeBytes = cover.sizeBytes;
    const uploadedAt = typeof cover.uploadedAt === "string" ? cover.uploadedAt.trim() : "";
    const allowedMimes = ["image/jpeg", "image/png", "image/webp"] as const;
    if (!fileId) throw new Error("手动上传封面缺少 fileId。");
    if (!originalName) throw new Error("手动上传封面缺少文件名。");
    if (!allowedMimes.includes(mimeType as (typeof allowedMimes)[number])) {
      throw new Error(`手动上传封面 mime 必须是 ${allowedMimes.join("、")} 之一。`);
    }
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error("手动上传封面 sizeBytes 必须是正整数。");
    }
    if (!uploadedAt) throw new Error("手动上传封面缺少 uploadedAt。");
    const next = structuredClone(product) as Record<string, unknown>;
    const presentation = objectValue(next.presentation);
    presentation.cover = {
      source: "manualUpload",
      fileId,
      originalName,
      mimeType,
      sizeBytes,
      poi,
      description,
      minQuality,
      uploadedAt,
    } satisfies ProductCover;
    delete presentation.coverFallback;
    next.presentation = presentation;
    return next;
  }
  throw new Error(`封面来源必须是 ctripLibrary 或 manualUpload，当前：${String((cover as { source?: unknown }).source)}`);
}

export type { ManualReviewFieldInput, ProductCover };