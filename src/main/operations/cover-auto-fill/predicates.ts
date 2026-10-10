/**
 * cover-auto-fill 的小谓词与值类型 helper：
 *   - safeObject：把任意值折叠成 Record<string, unknown> | null；
 *   - textValue：归一字符串（trim）；
 *   - positiveInteger：类型守卫（>= 1 整数）；
 *   - isCoverCandidateComplete：candidate 是否具备真实可写的 imageId + imageUrl + imageResolved=true；
 *   - isCoverCandidateSuitable：在 complete 之上要求分辨率 ≥ 1280×800 + quality 分数 ≥ minQuality（默认 3）；
 *   - isCtripLibraryCoverComplete：cover 是否已是 ctripLibrary / manualUpload 已完整形态；
 *   - pickFirstUsableCoverCandidate：从候选里挑第一条已真实解析可写回的；找不到返回 null。
 */

import type { CtripLibraryImageCandidate } from "../../../shared/contracts-types.js";

export function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isCoverCandidateComplete(candidate: Partial<CtripLibraryImageCandidate> | null | undefined): candidate is CtripLibraryImageCandidate & { imageId: number; imageUrl: string } {
  if (!candidate || typeof candidate !== "object") return false;
  if (!positiveInteger(candidate.imageId)) return false;
  const url = textValue(candidate.imageUrl);
  if (!url) return false;
  // 只有显式 true 才算「真实拿到」；false / undefined 都不写。
  if (candidate.imageResolved !== true) return false;
  return true;
}

export function isCoverCandidateSuitable(
  candidate: Partial<CtripLibraryImageCandidate> | null | undefined,
  minQuality = 3,
): candidate is CtripLibraryImageCandidate & { imageId: number; imageUrl: string } {
  if (!isCoverCandidateComplete(candidate)) return false;
  const dimensions = candidate.resolution?.match(/\d+/g)?.map(Number) ?? [];
  const [width = 0, height = 0] = dimensions;
  if (Math.max(width, height) < 1280 || Math.min(width, height) < 800) return false;
  const qualityScores = candidate.quality?.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const quality = qualityScores.length ? Math.min(...qualityScores) : candidate.score;
  return typeof quality === "number" && Number.isFinite(quality) && quality >= minQuality;
}

export function isCtripLibraryCoverComplete(cover: Record<string, unknown> | null | undefined): boolean {
  if (!cover) return false;
  const source = textValue(cover.source);
  if (source === "manualUpload") return true;
  if (source !== "ctripLibrary") return false;
  return positiveInteger(cover.imageId) && textValue(cover.imageUrl).length > 0;
}

/**
 * 从 candidate 列表里挑第一条已真实解析、可写回的景点图候选。
 * 找不到返回 null；不会抛错。
 */
export function pickFirstUsableCoverCandidate(
  candidates: ReadonlyArray<CtripLibraryImageCandidate> | undefined,
): CtripLibraryImageCandidate | null {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    if (isCoverCandidateComplete(candidate)) return candidate;
  }
  return null;
}