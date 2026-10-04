import type { Page } from "playwright";
import { searchCtripLibraryImages } from "../infrastructure/ctrip-library-search.js";
import type { CtripLibraryCoverAlternate, CtripLibraryImageCandidate, CtripLibrarySearchResult } from "../../shared/contracts-types.js";
import { logInfo } from "../../shared/log-timestamp.js";
import { collectSpotImageResiduals } from "./cover-spot-images.js";
import { missingTourImagePois, requiredTourImagePois } from "../../shared/tour-image-coverage.js";
import { applyCoverFallback } from "./cover-fallback.js";
import { itineraryAttractions, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import {
  buildCtripLibraryCoverAlternateFromCandidate,
  buildCtripLibraryCoverFromCandidate,
  readPreparedCoverImages,
} from "./cover-auto-fill-images.js";

export { applyCoverFallback } from "./cover-fallback.js";
export {
  buildCtripLibraryCoverAlternateFromCandidate,
  buildCtripLibraryCoverFromCandidate,
} from "./cover-auto-fill-images.js";

const COVER_IMAGE_TARGET_COUNT = 10;

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function matchesItineraryCoverPoi(
  candidate: CtripLibraryImageCandidate,
  keyword: string,
  product: Record<string, unknown>,
): boolean {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const spots = itinerary.flatMap((day) => {
    const record = safeObject(day);
    return Array.isArray(record?.spots) ? record.spots : [];
  }).map(safeObject).filter((spot): spot is Record<string, unknown> => Boolean(spot));
  const attractionSpots = itineraryAttractions(spots);
  const knownPoiIds = new Set(attractionSpots.map((spot) => spot.poiId).filter(positiveInteger));
  if (positiveInteger(candidate.poiId) && knownPoiIds.size) return knownPoiIds.has(candidate.poiId);
  const candidateName = textValue(candidate.poiName);
  // Some gallery rows omit their POI name after image resolution. Allow that
  // only when the itinerary has no bound POI IDs yet; otherwise a nameless
  // candidate cannot prove it belongs to the known itinerary set.
  if (!candidateName) return knownPoiIds.size === 0;
  return candidateName === keyword || candidateName.includes(keyword) || keyword.includes(candidateName);
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

/**
 * 决定搜 POI 的关键词（单数版本，保留以兼容旧测试 / 旧 import）：
 *   - 优先用 cover.poi（用户/AI 显式给出的代表景点）；
 *   - 否则按行程顺序遍历 itinerary[].spots[].name / poiName；
 *   - 都没有 → 返回 null（调用方放弃，不写半成品 cover）。
 */
export function pickCoverSearchKeyword(product: Record<string, unknown>): string | null {
  const keywords = collectCoverSearchKeywords(product);
  return keywords && keywords.length > 0 ? keywords[0] : null;
}

/**
 * 收集一组有序且去重的搜 POI 关键词：
 *   1. cover.poi 优先：用户/AI 显式给的代表景点作为首选关键词纳入；
 *      不再短路返回——若首个 POI 搜索无图 / 候选不完整，applyAutoCoverFill
 *      会按顺序尝试 itinerary 后续 POI（避免"代表景点无图就放弃"）。
 *   2. cover.poi 之后按以下顺序全收集（首次出现优先 + 大小写不敏感去重）：
 *        - itinerary[].spots[*]：按行程顺序，每个 spot 支持
 *          - 字符串；
 *          - { name }；
 *          - { poiName }；
 *        - 不用 day title、城市、商品名或文案兜底：封面检索只以景点 POI 为依据。
 *   3. 全部为空 → null（调用方放弃，不写半成品 cover）。
 */
export function collectCoverSearchKeywords(product: Record<string, unknown>): string[] | null {
  const presentation = safeObject(product.presentation);
  const cover = safeObject(presentation?.cover);
  const coverPoi = textValue(cover?.poi);

  const seen = new Set<string>();
  const result: string[] = [];

  const push = (raw: unknown): boolean => {
    const value = textValue(raw);
    if (!value) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(value);
    return true;
  };

  // cover.poi 显式给的：作为首选关键词纳入，但不短路返回；继续收集
  // itinerary spots 等后续关键词，便于首个 POI 在搜索无图/候选不完整时回退
  // 到其它具名景点（applyAutoCoverFill 会按顺序逐个尝试）。
  push(coverPoi);

  const itinerary = Array.isArray(product.itinerary) ? product.itinerary as Array<Record<string, unknown>> : [];
  for (const day of itinerary) {
    const dayRecord = safeObject(day);
    const spots = Array.isArray(dayRecord?.spots) ? dayRecord.spots as Array<unknown> : [];
    for (const spot of spots) {
      if (typeof spot === "string") {
        push(spot);
        continue;
      }
      const spotRecord = safeObject(spot);
      if (!spotRecord) continue;
      if (!requiresItineraryPoi(spotRecord)) continue;
      // 同一 spot 内 name > poiName 优先，去重由 push 内部保证。
      push(spotRecord.name) || push(spotRecord.poiName);
    }
  }

  return result.length > 0 ? result : null;
}

export interface AutoCoverFillOutcome {
  /** Whether cover or its internal fallback changed the product; false means nextProduct === product. */
  written: boolean;
  missingPoiImages?: string[];
  /** 没写时的简短原因（不会含任何敏感字段），用于 console.info / 日志。 */
  reason: string;
  /** 触发这次补齐时用的关键词（用于日志诊断）。 */
  keyword?: string;
  /** 选出来的 imageId（仅在 written=true 时存在）。 */
  imageId?: number;
  /** 实际准备好的 imageId 列表，第一张是主图，其余是备用图。 */
  imageIds?: number[];
  /** 阶段三实际写入 itinerary[].spots[].images 的图张数（仅在 written=true 时存在，0 表示无剩余图可归属）。 */
  spotImagesWritten?: number;
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
  injectSearch?: (page: Page, keyword: string) => Promise<CtripLibrarySearchResult>;
}): Promise<{ nextProduct: Record<string, unknown>; outcome: AutoCoverFillOutcome }> {
  const product = args.product;
  const presentation = safeObject(product.presentation);
  const existingCover = safeObject(presentation?.cover);
  const now = args.now ?? (() => new Date().toISOString());

  // manualUpload 的 cover 不应该被改成 ctripLibrary（用户已上传文件，自动化不应覆盖）；
  // 必须在「已完整」判断之前拦截，否则 isCtripLibraryCoverComplete 会因 manualUpload
  // 视为已完整而吞掉 manualUpload 专用 reason，日志排查不便。
  if (existingCover && textValue(existingCover.source) === "manualUpload") {
    return { nextProduct: product, outcome: { written: false, reason: "cover 为 manualUpload，跳过自动补齐" } };
  }

  const preparedImages = readPreparedCoverImages(existingCover);
  const existingCoverComplete = existingCover && isCtripLibraryCoverComplete(existingCover);
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
        : await searchCtripLibraryImages(args.page, keyword);
    } catch (error) {
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
        seenImageIds.add(image.imageId);
        progressed = true;
        break; // 每轮每个 pool 只取 1 张，保证各景点轮询公平。
      }
    }
  }

  const primary = pickedImages[0];

  if (!primary) {
    const reason = searchFailures > 0 ? "search_unavailable" : "no_qualified_candidate";
    const fallback = applyCoverFallback(product, reason, now);
    return {
      nextProduct: fallback.nextProduct,
      outcome: {
        written: fallback.written,
        reason: reason === "search_unavailable"
          ? `${keywords.length} 个景点（${keywords.join("、")}）中有 ${searchFailures} 个搜索失败，已设置待重试占位图；请重试或人工上传真实图片`
          : `已检索 ${keywords.length} 个景点（${keywords.join("、")}）且无合格图片，已设置待替换占位图`,
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
        ...(textValue(existingCover?.description) ? { description: existingCoverComplete ? primary.poi : textValue(existingCover?.description) } : {}),
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
      reason: existingCoverComplete
        ? `已补充携程图库封面备用图，共准备 ${imageIds.length} 张候选${spotImagesWritten > 0 ? `，另写入 ${spotImagesWritten} 张到行程景点` : ""}`
        : `已写入携程图库封面，并准备 ${imageIds.length} 张候选${spotImagesWritten > 0 ? `，另写入 ${spotImagesWritten} 张到行程景点` : ""}`,
      keyword: primaryKeyword,
      imageId: primary.imageId,
      imageIds,
      spotImagesWritten,
    },
  };
}
