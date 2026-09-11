/**
 * 首次 AI 规划完成后自动补齐携程图库封面的 helper（首轮 post-processing）。
 *
 * 触发时机：runAiReply 写入第一版产品 JSON 之后；
 * 不触发时机：用户后续补齐 / 重生成 / 手动修改 presentation.cover 后。
 *
 * 设计要点（参考 CLAUDE.md / AGENTS.md）：
 *   - 复用既有 searchCtripLibraryImages（阶段 A→B 直接链路），不引入新接口；
 *   - 只在 cover 缺 imageId/imageUrl 时尝试补；已有完整封面或 manualUpload 跳过；
 *   - poi 来源：cover.poi 优先；否则按行程顺序挑已写入行程的景点；没有就放弃（不写半成品）；
 *   - 候选必须 imageId > 0 + imageUrl 非空才算"完整"——选出来的首图同时
 *     含 imageId 与 imageUrl 才落库，否则保持原状；
 *   - 失败一律 console.info 提示但不抛错：search 接口不稳、VBK 未登录、网络抖动都属常态，
 *     第一轮草稿本身已经可用了，补封面失败不应该让用户重发消息；
 *   - 不打印 cookie / cookieorigin / ctok / 任何敏感字段；
 *   - 与现有自动化阶段共用同一个 BrowserView，不需要再开新会话。
 *
 * 函数导出：
 *   - pickCoverSearchKeyword：纯函数，决定用哪个关键词去搜 POI；
 *   - isCtripLibraryCoverComplete：纯函数判断 cover 是否已有 imageId/imageUrl；
 *   - pickFirstUsableCoverCandidate：纯函数，从 candidates 中挑第一条同时含
 *     imageId + imageUrl 的图；
 *   - buildCtripLibraryCoverFromCandidate：纯函数，把 candidate 合成产品 JSON 可用的
 *     presentation.cover 子树；
 *   - applyAutoCoverFill：在 main 进程侧串联「判断 → 搜索 → 选图 → 写回 product」
 *     的异步入口，捕获所有抛错并以 { written, reason } 返回。
 */
import type { Page } from "playwright";
import { searchCtripLibraryImages } from "../infrastructure/ctrip-library-search.js";
import type { CtripLibraryCoverAlternate, CtripLibraryImageCandidate, CtripLibrarySearchResult, ItinerarySpot } from "../../shared/contracts-types.js";
import { logInfo } from "../../shared/log-timestamp.js";
import {
  buildCtripLibraryCoverAlternateFromCandidate,
  buildCtripLibraryCoverFromCandidate,
  readPreparedCoverImages,
} from "./cover-auto-fill-images.js";

export {
  buildCtripLibraryCoverAlternateFromCandidate,
  buildCtripLibraryCoverFromCandidate,
} from "./cover-auto-fill-images.js";

/** 每个景点尽量多抓图，但同一产品封面最多准备这么多张（1 主图 + 其余备用）。 */
const COVER_IMAGE_TARGET_COUNT = 10;
/** 封面取满后，剩余候选图按 POI 归属写入 itinerary[].spots[].images；每个 spot 最多保留这么多张。 */
const SPOT_IMAGE_TARGET_COUNT = 10;

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

/** A gallery image must belong to the itinerary POI it is meant to represent. */
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
  const knownPoiIds = new Set(spots.map((spot) => spot.poiId).filter(positiveInteger));
  if (positiveInteger(candidate.poiId) && knownPoiIds.size) return knownPoiIds.has(candidate.poiId);
  const candidateName = textValue(candidate.poiName);
  // Some gallery rows omit their POI name after image resolution. Allow that
  // only when the itinerary has no bound POI IDs yet; otherwise a nameless
  // candidate cannot prove it belongs to the known itinerary set.
  if (!candidateName) return knownPoiIds.size === 0;
  return candidateName === keyword || candidateName.includes(keyword) || keyword.includes(candidateName);
}

/**
 * 任意 candidate 是否带可写回的 imageId + 非空 imageUrl。
 * 同时检查 imageResolved 以避免用「仅 DOM 占位」的脏数据：
 *   - imageResolved === true 才算「真实拿到」；
 *   - imageResolved === false / undefined 都视作未确认（候选未走
 *     getImageInfo 真解析路径），一律拒绝。
 */
export function isCoverCandidateComplete(candidate: Partial<CtripLibraryImageCandidate> | null | undefined): candidate is CtripLibraryImageCandidate & { imageId: number; imageUrl: string } {
  if (!candidate || typeof candidate !== "object") return false;
  if (!positiveInteger(candidate.imageId)) return false;
  const url = textValue(candidate.imageUrl);
  if (!url) return false;
  // 只有显式 true 才算「真实拿到」；false / undefined 都不写。
  if (candidate.imageResolved !== true) return false;
  return true;
}

/**
 * 判断当前 product.presentation.cover 是否已经完整（imageId + imageUrl 都齐）。
 * ctripLibrary 源看两个字段；manualUpload 源直接视为已完整（不应被自动改写）。
 * 缺字段返回 false，让 helper 决定是否补。
 */
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
      // 同一 spot 内 name > poiName 优先，去重由 push 内部保证。
      push(spotRecord.name) || push(spotRecord.poiName);
    }
  }

  return result.length > 0 ? result : null;
}

export interface AutoCoverFillOutcome {
  /** 是否真的把 cover 写回了 product；false 时 nextProduct === product。 */
  written: boolean;
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

/**
 * 主入口：runAiReply 在写入第一版产品之后调用一次。
 *
 * 输入：
 *   - page：main 进程侧 VbkBrowser.page() 的引用；不强制 await 外部 open()，
 *     内部仅发起 fetch 调用，浏览器自身已经登录；
 *   - product：当前持久化的产品对象（已是解析过的 plain object）。
 *
 * 输出：
 *   - nextProduct：写入完成的产品（written=false 时与 product 浅相等）；
 *   - outcome：诊断信息，便于上层 console.info 跟踪；
 *
 * 行为约束：
 *   - cover 已完整（isCtripLibraryCoverComplete）→ 直接返回，不搜；
 *   - search 接口抛错 / 候选空 / candidate 不完整 → 返回 { written: false, reason: "..." }，
 *     不抛错；上层应当只 console.info 不阻塞 ai:send 主流程；
 *   - 本函数不打印 cookie / cookieorigin / 任何凭证字段；
 *   - 通过 structuredClone 浅拷贝 product，避免外部引用被误改。
 */
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

  const keywords = collectCoverSearchKeywords(product);
  if (!keywords || keywords.length === 0) {
    if (existingCoverComplete) {
      return { nextProduct: product, outcome: { written: false, reason: "cover 已完整，但没有更多景点 POI 可补备用图" } };
    }
    return { nextProduct: product, outcome: { written: false, reason: "没有可用的景点 POI，跳过自动补齐" } };
  }
  if (existingCoverComplete && preparedImages.length >= COVER_IMAGE_TARGET_COUNT) {
    return { nextProduct: product, outcome: { written: false, reason: `cover 已准备 ${COVER_IMAGE_TARGET_COUNT} 张图片，跳过自动补齐` } };
  }

  // 阶段一：按有序去重的关键词逐个搜索，收集每个 POI 的「完整候选池」。
  // 与旧版「每个 keyword 只 find 第一张」不同，这里把一个 keyword 下所有
  // imageResolved=true 且匹配行程 POI 的候选都留下，交给阶段二轮询取图；
  // 搜索抛错 / 候选空 / 候选不完整时跳过该 keyword，不阻塞整次补齐。
  const pickedImages = [...preparedImages];
  const seenImageIds = new Set(pickedImages.map((item) => item.imageId));
  let primaryKeyword = textValue(pickedImages[0]?.poi) || undefined;

  interface KeywordPool {
    keyword: string;
    candidates: CtripLibraryImageCandidate[];
  }
  const pools: KeywordPool[] = [];
  for (const keyword of keywords) {
    let result: CtripLibrarySearchResult;
    try {
      // 允许调用方注入搜索函数（仅用于测试 / 调试），避免在单测里造假整个 Ctrip 网络栈。
      // 生产路径（main.ts）始终不传 injectSearch，走默认 searchCtripLibraryImages。
      result = args.injectSearch
        ? await args.injectSearch(args.page, keyword)
        : await searchCtripLibraryImages(args.page, keyword);
    } catch (error) {
      // 单个 keyword 的搜索失败不能让整次自动补齐停掉：继续下一个 keyword。
      logInfo(
        "[cover-auto-fill] keyword 搜索失败，继续尝试下一个",
        { keyword, error: error instanceof Error ? error.message : String(error) },
      );
      continue;
    }

    const candidates = result.candidates.filter((item) =>
      isCoverCandidateComplete(item)
      && matchesItineraryCoverPoi(item, keyword, product)
      && !seenImageIds.has(item.imageId),
    );
    if (candidates.length > 0) {
      pools.push({ keyword, candidates });
    }
  }

  // 阶段二：round-robin 轮询取图——每个景点先各取 1 张（保证覆盖所有景点），
  // 再从头轮流补足，直到达到 COVER_IMAGE_TARGET_COUNT 张或候选耗尽。
  // 去重只按 imageId：同一张图不会重复计入，但同一 POI 允许多张（用户要求
  // "越多越好"，不再像旧版那样每个景点强制只留 1 张）。
  const cursor = new Array<number>(pools.length).fill(0);
  let progressed = true;
  while (pickedImages.length < COVER_IMAGE_TARGET_COUNT && progressed) {
    progressed = false;
    for (let poolIndex = 0; poolIndex < pools.length && pickedImages.length < COVER_IMAGE_TARGET_COUNT; poolIndex += 1) {
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
    return {
      nextProduct: product,
      outcome: {
        written: false,
        reason: `所有 ${keywords.length} 个关键词（${keywords.join("、")}）都失败或未拿到完整候选，跳过自动补齐`,
      },
    };
  }

  if (existingCoverComplete && pickedImages.length === preparedImages.length) {
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

  const baseCover = existingCoverComplete
    ? { ...existingCover }
    : {
        source: "ctripLibrary",
        ...primary,
        ...(textValue(existingCover?.description) ? { description: textValue(existingCover?.description) } : {}),
        ...(typeof existingCover?.minQuality === "number" && Number.isFinite(existingCover.minQuality)
          ? { minQuality: existingCover.minQuality }
          : {}),
      };
  const alternates = pickedImages.slice(1, COVER_IMAGE_TARGET_COUNT);
  const nextCover = {
    ...baseCover,
    ...(alternates.length > 0 ? { alternates } : {}),
  };

  // 阶段三：把封面取满 10 张后未选中的候选图按 POI 归属写入 itinerary[].spots[].images。
  //   - seenImageIds 已包含 pickedImages 的所有 imageId，候选池里凡是已进封面的
  //     imageId 不会再次落到景点，避免同一张图既在 cover 又在 spot；
  //   - 匹配规则：candidate.poiId === spot.poiId 优先；否则 candidate.poiName 与
  //     spot.name / spot.poiName 互含（与 matchesItineraryCoverPoi 同源）；
  //   - 每个 spot 最多保留 SPOT_IMAGE_TARGET_COUNT 张（与封面同口径），按搜索
  //     返回顺序保留前 N 张；超出部分丢弃（保持数据量可控）。
  //   - 整次没有可写入的剩余图时，itinerary 整体不动。
  const nextItinerary = collectSpotImageResiduals({
    product,
    pools,
    coverUsedImageIds: seenImageIds,
    existingCover,
    now,
  });

  // 不动 product 其它子树，只覆盖 presentation.cover；如有剩余图归属，附带更新 itinerary。
  const nextProduct: Record<string, unknown> = {
    ...product,
    presentation: {
      ...presentation,
      cover: nextCover,
    },
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

/**
 * 阶段三 helper：从候选池中收集「未进封面」的图，按 POI 归属写入对应 spot.images。
 *   - 若没有任何剩余图需要写入，返回 null（调用方不需要更新 itinerary）；
 *   - 写回时只对真正变化了的 day / spot 重新构造对象，未变化的 day 保持原引用。
 */
function collectSpotImageResiduals(args: {
  product: Record<string, unknown>;
  pools: Array<{ keyword: string; candidates: CtripLibraryImageCandidate[] }>;
  coverUsedImageIds: Set<number>;
  existingCover: Record<string, unknown> | null;
  now: () => string;
}): Array<Record<string, unknown>> | null {
  const { product, pools, coverUsedImageIds, existingCover, now } = args;
  if (pools.length === 0) return null;
  if (!Array.isArray(product.itinerary) || product.itinerary.length === 0) return null;

  // 按 dayIndex:spotIndex 累计剩余图。
  const residualBySpot = new Map<string, CtripLibraryCoverAlternate[]>();
  for (const pool of pools) {
    for (const candidate of pool.candidates) {
      if (!isCoverCandidateComplete(candidate)) continue;
      if (coverUsedImageIds.has(candidate.imageId)) continue;
      const matched = findSpotForCandidate(product, candidate);
      if (!matched) continue;
      const key = `${matched.dayIndex}:${matched.spotIndex}`;
      const list = residualBySpot.get(key) ?? [];
      if (list.length >= SPOT_IMAGE_TARGET_COUNT) continue;
      list.push(buildCtripLibraryCoverAlternateFromCandidate({
        existingCover,
        candidate,
        keyword: pool.keyword,
        selectedAt: now(),
      }));
      residualBySpot.set(key, list);
    }
  }
  if (residualBySpot.size === 0) return null;

  // 构造新的 itinerary：只对真正写入的 day / spot 做不可变更新。
  const originalDays = product.itinerary as Array<Record<string, unknown>>;
  let mutated = false;
  const nextDays = originalDays.map((day, dayIndex) => {
    if (!isRecord(day) || !Array.isArray(day.spots)) return day;
    const originalSpots = day.spots as Array<Record<string, unknown>>;
    let dayMutated = false;
    const nextSpots = originalSpots.map((spot, spotIndex) => {
      if (!isRecord(spot)) return spot;
      const images = residualBySpot.get(`${dayIndex}:${spotIndex}`);
      if (!images || images.length === 0) return spot;
      dayMutated = true;
      return { ...spot, images };
    });
    if (!dayMutated) return day;
    mutated = true;
    return { ...day, spots: nextSpots };
  });
  return mutated ? nextDays : null;
}

/**
 * 把 candidate 映射到 itinerary 中的某个 spot。
 * 匹配规则（与 matchesItineraryCoverPoi 共享一套语义但更宽容）：
 *   1) candidate.poiId === spot.poiId（正整数相等）；
 *   2) candidate.poiName 与 spot.name / spot.poiName 互含（任一非空即匹配）；
 *   3) 都缺则不匹配（无证据证明属于行程中的某个景点）。
 * 返回首个匹配项的索引 + 引用；找不到返回 null。
 */
function findSpotForCandidate(
  product: Record<string, unknown>,
  candidate: CtripLibraryImageCandidate,
): { dayIndex: number; spotIndex: number; spot: ItinerarySpot } | null {
  if (!Array.isArray(product.itinerary)) return null;
  const candidatePoiId = positiveInteger(candidate.poiId);
  const candidateName = textValue(candidate.poiName);
  for (let dayIndex = 0; dayIndex < product.itinerary.length; dayIndex += 1) {
    const day = safeObject(product.itinerary[dayIndex]);
    if (!day || !Array.isArray(day.spots)) continue;
    for (let spotIndex = 0; spotIndex < day.spots.length; spotIndex += 1) {
      const raw = day.spots[spotIndex];
      const spot = safeObject(raw) as ItinerarySpot | null;
      if (!spot) continue;
      // 字符串 spot 不支持 images 写入，跳过。
      if (typeof raw === "string") continue;
      // 1) poiId 相等优先。
      if (candidatePoiId && positiveInteger(spot.poiId) === candidatePoiId) {
        return { dayIndex, spotIndex, spot };
      }
      // 2) poiName / name 互含。
      if (candidateName) {
        const spotName = textValue(spot.name);
        const spotPoiName = textValue(spot.poiName);
        if (spotName && (candidateName === spotName || candidateName.includes(spotName) || spotName.includes(candidateName))) {
          return { dayIndex, spotIndex, spot };
        }
        if (spotPoiName && (candidateName === spotPoiName || candidateName.includes(spotPoiName) || spotPoiName.includes(candidateName))) {
          return { dayIndex, spotIndex, spot };
        }
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
