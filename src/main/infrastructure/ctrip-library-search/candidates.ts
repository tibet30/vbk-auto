/**
 * 候选构造器（私有 helpers）：
 *   - buildPlaceCandidateFromPoi：阶段 A 的 SuggestPoiParsedPoi → CtripLibraryPlaceCandidate；
 *   - buildCandidateFromImageInfo：阶段 B 的 imageId + getImageInfo → CtripLibraryImageCandidate；
 *
 * 单独抽离是因为它们同时被"对外入口"和"单元测试"复用，留在主文件会污染行数且
 * 不利于单独验证。
 */

import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
} from "../../../shared/contracts-types.js";
import type { CtripLibraryImageInfo } from "../ctrip-image-info.js";
import type { SuggestPoiParsedPoi } from "../ctrip-library-protocol.js";

export function buildPlaceCandidateFromPoi(poi: SuggestPoiParsedPoi, index: number): CtripLibraryPlaceCandidate {
  const stableId = `poi:${poi.poiId}`;
  return {
    stableId,
    index,
    poiId: poi.poiId,
    poiName: poi.poiName,
    address: poi.address ?? null,
    province: poi.province ?? null,
    city: poi.city ?? null,
    district: poi.district ?? null,
    rawText: `poiId=${poi.poiId}`,
  };
}

export function buildCandidateFromImageInfo(args: {
  imageId: number;
  index: number;
  poi: SuggestPoiParsedPoi;
  info: CtripLibraryImageInfo | undefined;
}): CtripLibraryImageCandidate {
  const { imageId, index, poi, info } = args;
  const stableId = `imageId:${imageId}`;
  if (!info) {
    // searchImage 给出了 imageId，但 getImageInfo 没拿到：仍占位返回，UI 走空提示。
    return {
      stableId,
      index,
      quality: "",
      resolution: "",
      imageId,
      poiId: poi.poiId,
      poiName: poi.poiName,
      imageResolved: false,
      rawText: `poiId=${poi.poiId}`,
    };
  }
  const thumbnailUrl = info.thumbnailUrl ?? undefined;
  const previewUrl = info.previewUrl ?? undefined;
  const originalUrl = info.originalUrl ?? undefined;
  const imageUrl = thumbnailUrl ?? previewUrl ?? originalUrl;
  const candidate: CtripLibraryImageCandidate = {
    stableId,
    index,
    quality: info.score !== null ? String(info.score) : "",
    resolution: info.resolution ?? "",
    imageId: info.imageId ?? imageId,
    poiId: info.poiId ?? poi.poiId,
    poiName: info.poiName ?? poi.poiName,
    score: info.score ?? undefined,
    fileName: info.fileName ?? undefined,
    districtName: info.districtName ?? undefined,
    countryName: info.countryName ?? undefined,
    thumbnailUrl,
    previewUrl,
    imageUrl: imageUrl ?? undefined,
    imageResolved: true,
  };
  candidate.rawText = `imageId=${imageId};poiId=${info.poiId ?? poi.poiId}`;
  return candidate;
}