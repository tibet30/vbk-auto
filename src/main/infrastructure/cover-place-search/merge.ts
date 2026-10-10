/**
 * 图片信息回填（mergeImageInfo + 配套 helpers）：
 *   - mergeImageInfo：CtripLibraryImageInfo → CoverPlaceCandidate 字段子集；
 *   - stripUndefined：去掉值为 undefined 的键，避免覆盖候选上已有的兜底字段；
 *   - recordImageIdCandidate：记录 imageId → candidateKey 反向索引，用于批量回填；
 *   - normaliseName：候选 dedup 时的 key 归一化（去括号 / 空白 / 小写）。
 */

import type { CoverPlaceCandidate } from "../../../shared/contracts-types.js";
import type { CtripLibraryImageInfo } from "../ctrip-image-info.js";

/**
 * 把 CtripLibraryImageInfo 转成可合并到候选的字段集合：
 *  - imageId：getImageInfo 返回的图片主键；与 textFields 抽到的 imageId 通常一致，
 *    但仍显式回填（兼容 textFields 缺 imageId / 浏览器端返回额外字段的边界）。
 *  - imageUrl：优先 thumbnailUrl（200 档），缺失回退 previewUrl（500 档），再缺失 originalUrl；
 *  - score / resolution / imageInfoPoiId / imageInfoPoiName：原样映射。
 */
export function mergeImageInfo(info: CtripLibraryImageInfo): Partial<CoverPlaceCandidate> {
  return {
    imageId: info.imageId ?? undefined,
    imageUrl: info.thumbnailUrl ?? info.previewUrl ?? info.originalUrl ?? undefined,
    score: info.score ?? undefined,
    resolution: info.resolution ?? undefined,
    imageInfoPoiId: info.poiId ?? undefined,
    imageInfoPoiName: info.poiName ?? undefined,
  };
}

/** 去掉值为 undefined 的键，避免覆盖候选上已有的兜底字段。 */
export function stripUndefined(value: Partial<CoverPlaceCandidate>): Partial<CoverPlaceCandidate> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<CoverPlaceCandidate>;
}

/**
 * 记录候选的 imageId → candidateKey 反向索引，用于 fetchCtripImageInfo 后回填。
 * 无 imageId 时跳过；同一 imageId 对应多候选（同名候选跨 variant 命中）一并记录。
 */
export function recordImageIdCandidate(
  index: Map<number, string[]>,
  candidate: CoverPlaceCandidate,
  candidateKey: string,
): void {
  if (candidate.imageId === undefined) return;
  const list = index.get(candidate.imageId);
  if (list) {
    if (!list.includes(candidateKey)) list.push(candidateKey);
  } else {
    index.set(candidate.imageId, [candidateKey]);
  }
}

export function normaliseName(name: string): string {
  return name.replace(/[（）()\s]/g, "").toLowerCase();
}