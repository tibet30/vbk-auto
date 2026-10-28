/**
 * applyAutoCoverFill 主流程：
 *   - manualUpload → 合格原图不写；尺寸不足时保留原图并查找图库替代；
 *   - 已完整 + 已有足够多图 + 无缺失 POI → 不写；
 *   - 阶段一：按 collectCoverSearchKeywords 有序去重逐个搜，收集每个 POI 的完整候选池；
 *   - 阶段二：先把 requiredTourImagePois 的代表图按 imageId 去重轮询挑一张，再轮询补足到 imageTargetCount；
 *   - 阶段三：把剩余候选按真实 POI 归属写入 itinerary[].spots[].images（cover-spot-images）；
 *   - 无合格图或检索失败时不写占位图，返回阻塞原因，由 readiness 的封面缺口拦住录入。
 *
 * 关键约束：
 *   - 仅主进程确认尺寸不足后允许 manualUpload → ctripLibrary；
 *   - 单次搜索失败不停下整次补齐；
 *   - 每个 pool 每轮只取 1 张，保证各景点公平轮询。
 */

import { isReplayDataMissing } from "../../infrastructure/replay-data-error.js";
import { inspectManualCoverAsset } from "../../automation/manual-cover-asset.js";
import type { Page } from "playwright";
import { searchCtripLibraryImages } from "../../infrastructure/ctrip-library-search.js";
import { coverSearchLogger } from "../../infrastructure/cover-place-search-logger.js";
import type { CtripLibraryImageCandidate, CtripLibrarySearchResult } from "../../../shared/contracts-types.js";
import { logInfo } from "../../../shared/log-timestamp.js";
import { collectSpotImageResiduals } from "../cover-spot-images.js";
import { missingTourImagePois, requiredTourImagePois } from "../../../shared/tour-image-coverage.js";
import {
  buildCtripLibraryCoverAlternateFromCandidate,
  readPreparedCoverImages,
} from "../cover-auto-fill-images.js";
import { isCtripLibraryCoverComplete, isCoverCandidateComplete, isCoverCandidateSuitable, safeObject, textValue } from "./predicates.js";
import { collectCoverSearchKeywords, matchesItineraryCoverPoi } from "./keywords.js";
import type { AutoCoverFillOutcome } from "./outcome.js";

const COVER_IMAGE_TARGET_COUNT = 10;

function shouldRefreshDescription(
  existingCover: Record<string, unknown> | null | undefined,
  primaryPoi: string,
  existingCoverComplete: boolean,
  replaceManualCover: boolean,
): boolean {
  if (existingCoverComplete || replaceManualCover) return true;
  const previousPoi = textValue(existingCover?.poi);
  const description = textValue(existingCover?.description);
  return Boolean(previousPoi && previousPoi !== primaryPoi && description.includes(previousPoi));
}

export async function applyAutoCoverFill(args: {
  page: Page;
  product: Record<string, unknown>;
  now?: () => string;
  /**
   * 仅用于测试 / 调试：注入自定义搜索函数。
   * 默认走 searchCtripLibraryImages；不引入这个参数时，生产路径不变。
   * 单测可借此直接返回完整候选，避免伪造整个 Ctrip 网络栈。
   */
  generateCover?: import("../generated-cover.js").CoverGenerator;
  inspectManualCover?: typeof inspectManualCoverAsset;
  injectSearch?: (page: Page, keyword: string) => Promise<CtripLibrarySearchResult>;
}): Promise<{ nextProduct: Record<string, unknown>; outcome: AutoCoverFillOutcome }> {
  const product = args.product;
  const presentation = safeObject(product.presentation);
  const existingCover = safeObject(presentation?.cover);
  const now = args.now ?? (() => new Date().toISOString());

  let replaceManualCover = false;
  if (existingCover && textValue(existingCover.source) === "manualUpload") {
    // Only a decoded local file with insufficient dimensions permits replacement.
    // Missing/corrupt files and unverified assets keep the original and its gate.
    try {
      replaceManualCover = (args.inspectManualCover ?? inspectManualCoverAsset)(product).reason === "dimensions";
    } catch {
      replaceManualCover = false;
    }
    if (!replaceManualCover) {
      return { nextProduct: product, outcome: { written: false, reason: "cover 为 manualUpload，跳过自动补齐" } };
    }
  }

  const preparedImages = replaceManualCover ? [] : readPreparedCoverImages(existingCover);
  const existingCoverComplete = !replaceManualCover && existingCover && isCtripLibraryCoverComplete(existingCover);
  const minQuality = typeof existingCover?.minQuality === "number" && Number.isFinite(existingCover.minQuality)
    ? existingCover.minQuality : 3;

  const keywords = collectCoverSearchKeywords(product);
  if (!keywords || keywords.length === 0) {
    if (existingCoverComplete) {
      return { nextProduct: product, outcome: { written: false, reason: "cover 已完整，但没有更多景点 POI 可补备用图" } };
    }
    return { nextProduct: product, outcome: { written: false, reason: "没有可用的景点 POI，跳过自动补齐" } };
  }
  const requiredPois = requiredTourImagePois(product);
  const imageTargetCount = Math.min(20, Math.max(COVER_IMAGE_TARGET_COUNT, requiredPois.length));
  if (existingCoverComplete && preparedImages.length >= imageTargetCount && !missingTourImagePois(product, preparedImages).length) {
    return { nextProduct: product, outcome: { written: false, reason: `cover 已准备 ${COVER_IMAGE_TARGET_COUNT} 张图片，跳过自动补齐` } };
  }

  // 阶段一：按有序去重的关键词逐个搜索，收集每个 POI 的「完整候选池」。
  const primaryRequired = preparedImages[0] && requiredPois.some(poi => poi.poiId
    ? preparedImages[0].poiId === poi.poiId : (preparedImages[0].poiName || preparedImages[0].poi) === poi.name);
  // 达到平台容量时，自动封面也必须给收费景点覆盖让位。
  const pickedImages = preparedImages.slice(0, requiredPois.length >= imageTargetCount && !primaryRequired ? 0 : 1);
  const seenImageIds = new Set<number>();
  let primaryKeyword = textValue(pickedImages[0]?.poi) || undefined;

  interface KeywordPool {
    keyword: string;
    candidates: CtripLibraryImageCandidate[];
  }
  const pools: KeywordPool[] = [];
  let searchFailures = 0;
  for (const keyword of keywords) {
    let result: CtripLibrarySearchResult;
    try {
      // 允许调用方注入搜索函数（仅用于测试 / 调试），避免在单测里造假整个 Ctrip 网络栈。
      // 生产路径（main.ts）始终不传 injectSearch，走默认 searchCtripLibraryImages。
      result = args.injectSearch
        ? await args.injectSearch(args.page, keyword)
        : await searchCtripLibraryImages(args.page, keyword, { logger: coverSearchLogger });
    } catch (error) {
      if (isReplayDataMissing(error)) throw error;
      searchFailures += 1;
      // 单个 keyword 的搜索失败不能让整次自动补齐停掉：继续下一个 keyword。
      logInfo(
        "[cover-auto-fill] keyword 搜索失败，继续尝试下一个",
        { keyword, error: error instanceof Error ? error.message : String(error) },
      );
      continue;
    }

    const candidates = result.candidates.filter((item) =>
      isCoverCandidateSuitable(item, minQuality)
      && matchesItineraryCoverPoi(item, keyword, product)
      && !seenImageIds.has(item.imageId),
    );
    if (candidates.length > 0) {
      pools.push({ keyword, candidates });
    }
  }

  // 先逐景点取代表图，再轮询补足；按 imageId 去重。
  for (const poi of [...requiredPois].sort((a, b) => keywords.indexOf(a.name) - keywords.indexOf(b.name))) {
    if (pickedImages.some(image => poi.poiId ? image.poiId === poi.poiId : (image.poiName || image.poi) === poi.name)) continue;
    const existing = preparedImages.find(image => poi.poiId ? image.poiId === poi.poiId : (image.poiName || image.poi) === poi.name);
    const pool = pools.find(pool => pool.candidates.some(candidate => poi.poiId ? candidate.poiId === poi.poiId : candidate.poiName === poi.name || pool.keyword === poi.name));
    const candidate = pool?.candidates.find(candidate => poi.poiId ? candidate.poiId === poi.poiId : candidate.poiName === poi.name || pool.keyword === poi.name);
    const image = existing ?? (candidate && isCoverCandidateComplete(candidate)
      ? buildCtripLibraryCoverAlternateFromCandidate({ existingCover, candidate, keyword: pool!.keyword, selectedAt: now() }) : undefined);
    if (image && pickedImages.length < imageTargetCount && !pickedImages.some(item => item.imageId === image.imageId)) {
      if (!pickedImages.length) primaryKeyword = pool?.keyword || image.poi;
      pickedImages.push(image);
    }
  }
  for (const image of preparedImages.slice(1)) {
    if (pickedImages.length < imageTargetCount && !pickedImages.some(item => item.imageId === image.imageId)) pickedImages.push(image);
  }
  for (const image of pickedImages) seenImageIds.add(image.imageId);
  const cursor = new Array<number>(pools.length).fill(0);
  let progressed = true;
  while (pickedImages.length < imageTargetCount && progressed) {
    progressed = false;
    for (let poolIndex = 0; poolIndex < pools.length && pickedImages.length < imageTargetCount; poolIndex += 1) {
      const pool = pools[poolIndex];
      while (cursor[poolIndex] < pool.candidates.length) {
        const candidate = pool.candidates[cursor[poolIndex]];
        cursor[poolIndex] += 1;
        if (!isCoverCandidateComplete(candidate) || seenImageIds.has(candidate.imageId)) continue;
        const image = buildCtripLibraryCoverAlternateFromCandidate({
          existingCover,
          candidate,
          keyword: pool.keyword,
          selectedAt: now(),
        });
        const willBecomePrimary = pickedImages.length === 0;
        pickedImages.push(image);
        if (willBecomePrimary) primaryKeyword = pool.keyword;
        seenImageIds.add(candidate.imageId);
        progressed = true;
        break; // 每轮每个 pool 只取 1 张，保证各景点轮询公平。
      }
    }
  }

  const primary = pickedImages[0];

  if (!primary && searchFailures === 0 && args.generateCover) {
    try {
      const generated = await args.generateCover(product);
      const nextPresentation: Record<string, unknown> = { ...presentation, cover: generated };
      if (replaceManualCover) {
        const preserved = Array.isArray(presentation?.preservedManualCovers) ? presentation.preservedManualCovers : [];
        nextPresentation.preservedManualCovers = preserved.some(item => safeObject(item)?.fileId === existingCover?.fileId)
          ? preserved : [...preserved, { ...existingCover }];
      }
      delete nextPresentation.coverFallback;
      return { nextProduct: { ...product, presentation: nextPresentation }, outcome: { written: true,
        reason: "图库无合格候选，已按当前产品生成主题插画并保存本地副本；请重新审批。" } };
    } catch (error) {
      if (isReplayDataMissing(error)) throw error;
      return { nextProduct: product, outcome: { written: false,
        reason: error instanceof Error ? error.message : "AI 封面生成失败，已保留原封面。" } };
    }
  }

  if (!primary && replaceManualCover) {
    return { nextProduct: product, outcome: { written: false, reason: searchFailures > 0
      ? "图库查询暂不可用，已保留手动原图；尺寸门禁仍阻塞，请稍后重试。"
      : "未找到合格图库候选，已保留手动原图；尺寸门禁仍阻塞。" } };
  }

  if (!primary) {
    // 不再写运营占位图：保持产品原样，由 readiness 的「封面图」缺口阻塞录入。
    return {
      nextProduct: product,
      outcome: {
        written: false,
        reason: searchFailures > 0
          ? `${keywords.length} 个景点（${keywords.join("、")}）中有 ${searchFailures} 个搜索失败，请重试或人工上传/选择图库图片`
          : `已检索 ${keywords.length} 个景点（${keywords.join("、")}）且无合格图片，请重试或人工上传/选择图库图片`,
      },
    };
  }

  if (existingCoverComplete && pickedImages.length === preparedImages.length && pickedImages.every((image, index) => image.imageId === preparedImages[index]?.imageId) && !missingTourImagePois(product, pickedImages).length) {
    return {
      nextProduct: product,
      outcome: {
        written: false,
        reason: `已保留现有封面，但其它 ${keywords.length} 个关键词（${keywords.join("、")}）未补到新的备用图`,
        keyword: primaryKeyword,
        imageId: primary.imageId,
        imageIds: pickedImages.map((item) => item.imageId),
      },
    };
  }

  const baseCover = existingCoverComplete && primary.imageId === existingCover?.imageId
    ? { ...existingCover }
    : {
        source: "ctripLibrary",
        ...primary,
        ...(textValue(existingCover?.description) ? {
          description: shouldRefreshDescription(existingCover, primary.poi, Boolean(existingCoverComplete), replaceManualCover)
            ? primary.poi
            : textValue(existingCover?.description),
        } : {}),
        ...(typeof existingCover?.minQuality === "number" && Number.isFinite(existingCover.minQuality)
          ? { minQuality: existingCover.minQuality }
          : {}),
      };
  const alternates = pickedImages.slice(1, imageTargetCount);
  const nextCover = {
    ...baseCover,
    missingPoiImages: missingTourImagePois(product, pickedImages).map(poi => poi.name),
    ...(alternates.length > 0 ? { alternates } : {}),
  };

  // 剩余候选按真实 POI 归属写入景点图片，不与相册重复。
  const nextItinerary = collectSpotImageResiduals({
    product,
    pools,
    coverUsedImageIds: seenImageIds,
    existingCover,
    now,
  });

  // 不动 product 其它子树，只覆盖 presentation.cover；如有剩余图归属，附带更新 itinerary。
  const nextPresentation: Record<string, unknown> = { ...presentation, cover: nextCover };
  if (replaceManualCover) {
    const preserved = Array.isArray(presentation?.preservedManualCovers) ? presentation.preservedManualCovers : [];
    nextPresentation.preservedManualCovers = preserved.some(item => safeObject(item)?.fileId === existingCover?.fileId)
      ? preserved : [...preserved, { ...existingCover }];
  }
  delete nextPresentation.coverFallback;
  const nextProduct: Record<string, unknown> = {
    ...product,
    presentation: nextPresentation,
    ...(nextItinerary ? { itinerary: nextItinerary } : {}),
  };

  const imageIds = pickedImages.map((item) => item.imageId);
  const spotImagesWritten = nextItinerary
    ? nextItinerary.reduce<number>((sum, day) => {
        const spots = Array.isArray((day as Record<string, unknown>).spots) ? (day as Record<string, unknown>).spots as Array<Record<string, unknown>> : [];
        return sum + spots.reduce<number>((acc, spot) => {
          const images = Array.isArray(spot.images) ? spot.images as Array<unknown> : [];
          return acc + images.length;
        }, 0);
      }, 0)
    : 0;
  return {
    nextProduct,
    outcome: {
      written: true,
      missingPoiImages: nextCover.missingPoiImages,
      reason: replaceManualCover
        ? "手动封面尺寸不足，已保留原图并换用合格携程图库封面；当前方案必须重新审批。"
        : existingCoverComplete
        ? `已补充携程图库封面备用图，共准备 ${imageIds.length} 张候选${spotImagesWritten > 0 ? `，另写入 ${spotImagesWritten} 张到行程景点` : ""}`
        : `已写入携程图库封面，并准备 ${imageIds.length} 张候选${spotImagesWritten > 0 ? `，另写入 ${spotImagesWritten} 张到行程景点` : ""}`,
      keyword: primaryKeyword,
      imageId: primary.imageId,
      imageIds,
      spotImagesWritten,
    },
  };
}
