/**
 * 携程图库封面候选排序：把主图 + alternates[] 合并、去重、按 imageId 优先。
 *  - ctripLibraryCoverAttempts(cover)：返回 imageId / imageUrl / poi 完整
 *    的候选数组，供 selectCtripLibraryCover 和 bindCtripLibraryAttractionImage
 *    一起用，避免封面绑定时漏掉可用的备选图。
 *
 * 与外部契约对齐：contracts-ctrip-cover.CtripLibraryCover / CtripLibraryCoverAlternate
 * 是 alternates 与主 cover 同形态；schema 在 album.aiAbstract 阶段填好的 alternates
 * 会被这里拼成统一的尝试序列。
 */

import type { CtripLibraryCover, CtripLibraryCoverAlternate } from "../../../../../shared/contracts-ctrip-cover.js";

type CtripLibraryCoverSource = CtripLibraryCover | CtripLibraryCoverAlternate;

export interface CtripLibraryCoverCandidate {
  imageId: number;
  imageUrl: string;
  poi: string;
  poiId?: number;
  poiName?: string;
}

export function ctripLibraryCoverAttempts(cover: CtripLibraryCover): CtripLibraryCoverCandidate[] {
  const candidates: CtripLibraryCoverCandidate[] = [];
  const push = (source: CtripLibraryCoverSource | undefined) => {
    if (!source) return;
    const imageId = Number(source?.imageId);
    const imageUrl = typeof source?.imageUrl === "string" ? source.imageUrl.trim() : "";
    const poi = typeof source?.poi === "string" ? source.poi.trim() : "";
    if (!Number.isInteger(imageId) || imageId <= 0 || !imageUrl || !poi) return;
    if (candidates.some((candidate) => candidate.imageId === imageId)) return;
    candidates.push({
      imageId,
      imageUrl,
      poi,
      poiId: source.poiId,
      poiName: source.poiName,
    });
  };
  push(cover);
  if (Array.isArray(cover?.alternates)) {
    for (const alternate of cover.alternates) push(alternate);
  }
  return candidates;
}

export type { CtripLibraryCoverSource };