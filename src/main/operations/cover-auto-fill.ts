/**
 * 首次 AI 规划完成后自动补齐携程图库封面的 helper（首轮 post-processing）。
 *
 * 触发时机：runAiReply 写入第一版产品 JSON 之后；
 * 不触发时机：用户后续补齐 / 重生成 / 手动修改 presentation.cover 后。
 *
 * 设计要点（参考 CLAUDE.md / AGENTS.md）：
 *   - 复用既有 searchCtripLibraryImages（阶段 A→B 直接链路），不引入新接口；
 *   - 只在 cover 缺 imageId/imageUrl 时尝试补；已有完整封面或 manualUpload 跳过；
 *   - poi 来源：cover.poi 优先；否则按行程顺序挑一个具名 spot；
 *     再否则用 basicInfo.destinationCity / meetingCity；都没有就放弃（不写半成品）；
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
import type { CtripLibraryImageCandidate, CtripLibrarySearchResult } from "../../shared/contracts-types.js";
import { logInfo } from "../../shared/log-timestamp.js";

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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
 * 从 candidate 列表里挑第一条「同时含 imageId + imageUrl + imageResolved=true」的可用候选。
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
 *   - 否则按行程顺序遍历 itinerary[].spots[].name，取第一个非空名；
 *   - 再否则用 basicInfo.destinationCity / meetingCity / title；
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
 *        - 若当日所有 spot 都拿不到，非通用 / 非交通类的 day title 才纳入；
 *        - basicInfo.destinationCity / meetingCity 先；
 *        - 仅当 itinerary 一无所获时，才追加 supplierProductName / subtitle
 *          （避免「代表景点 = 商品名」这种丢人的回退）。
 *   3. 全部为空 → null（调用方放弃，不写半成品 cover）。
 */
const NOISY_DAY_TITLE_RE = /^(?:交通|出发|返程|送机|接机|送站|接站|抵达|离开|前往|自由活动|行程结束|大巴|car|bus|train|flight)$/i;

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

  let itineraryContributed = false;
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary as Array<Record<string, unknown>> : [];
  for (const day of itinerary) {
    const dayRecord = safeObject(day);
    const spots = Array.isArray(dayRecord?.spots) ? dayRecord.spots as Array<unknown> : [];
    let daySpotPushed = false;
    for (const spot of spots) {
      if (typeof spot === "string") {
        if (push(spot)) daySpotPushed = true;
        continue;
      }
      const spotRecord = safeObject(spot);
      if (!spotRecord) continue;
      // 同一 spot 内 name > poiName 优先，去重由 push 内部保证。
      // 已存在（被 cover.poi 等前置去重剔除）的 spot 名称同样算"已贡献"，
      // 不再回退到 day title（避免 cover.poi 与 itinerary spot 同名时
      // 把 day title "太原" 这种通用词误搜为 POI）。
      const rawName = textValue(spotRecord.name);
      const rawPoiName = textValue(spotRecord.poiName);
      if (rawName && seen.has(rawName.toLowerCase())) {
        daySpotPushed = true;
      } else if (rawPoiName && seen.has(rawPoiName.toLowerCase())) {
        daySpotPushed = true;
      } else if (push(spotRecord.name)) {
        daySpotPushed = true;
      } else if (push(spotRecord.poiName)) {
        daySpotPushed = true;
      }
    }
    // 当天 spot 都拿不到 → 才看 day title；并跳过明显的通用 / 交通类标题。
    if (!daySpotPushed) {
      const rawTitle = textValue(dayRecord?.title);
      if (rawTitle && !NOISY_DAY_TITLE_RE.test(rawTitle)) {
        if (push(rawTitle)) itineraryContributed = true;
      }
    }
    if (daySpotPushed) itineraryContributed = true;
  }

  // itinerary 一无所获（空 itinerary / 全空 spot / 全被过滤的 day title）才回退 basicInfo，
  // 避免「代表景点 = 商品名」这种丢人的回退。
  if (!itineraryContributed) {
    const basic = safeObject(product.basicInfo);
    const hadCity = push(basic?.destinationCity) || push(basic?.meetingCity);
    // 仅当 destinationCity / meetingCity 都没拿到时，才用 supplierProductName / subtitle 兜底，
    // 避免 basicInfo 同时给城市 + 商品名时把"太原2天1晚私家团"也作为 POI 拿去搜。
    if (!hadCity) {
      push(basic?.supplierProductName);
      push(basic?.subtitle);
    }
  }

  return result.length > 0 ? result : null;
}

/**
 * 把 candidate 合成可写回 product JSON 的 presentation.cover 子树。
 * 不修改入参；不写 file / 不发请求；纯函数。
 * 必填字段（source / imageId / imageUrl / poi / description / minQuality）都从 cover 继承，
 * 没有 cover 入参时直接抛错（调用方应先 pickCoverSearchKeyword + isCtripLibraryCoverComplete）。
 */
export function buildCtripLibraryCoverFromCandidate(args: {
  existingCover: Record<string, unknown> | null | undefined;
  candidate: CtripLibraryImageCandidate & { imageId: number; imageUrl: string };
  keyword: string;
  selectedAt: string;
  /** description fallback when existingCover is null (AI didn't generate cover)。 */
  fallbackDescription?: string;
}): Record<string, unknown> {
  const existing = safeObject(args.existingCover);
  // cover.poi 必须代表「成功搜到 / 选中的 POI」，不能继承前一次失败的 existing.poi。
  // 例如：cover.poi=云冈石窟 搜不到，回退搜 keyword=晋祠 拿到 candidate.poiName=晋祠博物馆；
  // 此时 cover.poi 应是「晋祠博物馆」，否则 cover.poi 与 selected image 不匹配。
  // 优先级：candidate.poiName（最贴近真实选中的 POI）→ keyword（搜索用的关键词）
  // → existing.poi（最后兜底，避免完全空）。
  const poi =
    textValue(args.candidate.poiName)
    || textValue(args.keyword)
    || (existing ? textValue(existing.poi) : "");
  const description = existing
    ? (textValue(existing.description) || `${args.keyword} 封面图`)
    : (args.fallbackDescription || `${args.keyword} 封面图`);
  const rawQuality = existing?.minQuality;
  const minQuality = typeof rawQuality === "number" && Number.isFinite(rawQuality) ? rawQuality : 3;
  const next: Record<string, unknown> = {
    source: "ctripLibrary",
    imageId: args.candidate.imageId,
    imageUrl: args.candidate.imageUrl,
    poi,
    description,
    minQuality,
    selectedAt: args.selectedAt,
  };
  // 透传 candidate 上的派生字段，方便 UI / 复核。
  const thumbnailUrl = textValue(args.candidate.thumbnailUrl);
  if (thumbnailUrl) next.thumbnailUrl = thumbnailUrl;
  const previewUrl = textValue(args.candidate.previewUrl);
  if (previewUrl) next.previewUrl = previewUrl;
  if (typeof args.candidate.score === "number") next.score = args.candidate.score;
  const resolution = textValue(args.candidate.resolution);
  if (resolution) next.resolution = resolution;
  if (positiveInteger(args.candidate.poiId)) next.poiId = args.candidate.poiId;
  const poiName = textValue(args.candidate.poiName);
  if (poiName) next.poiName = poiName;
  return next;
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

  // 已有完整 cover（含 imageId + imageUrl）不补。
  if (existingCover && isCtripLibraryCoverComplete(existingCover)) {
    return { nextProduct: product, outcome: { written: false, reason: "cover 已完整，跳过自动补齐" } };
  }

  // 没有 cover 也没有 description / minQuality → 没法写「完整」cover，干脆放弃。
  let fallbackDescription: string | undefined;
  if (!existingCover) {
    // cover 完全缺失时，从 AI 已生成的 features / recommendation 中提取
    // 描述文本（取前 100 字），继续搜索图库补齐。
    const derived = (textValue(presentation?.features) || textValue(presentation?.recommendation) || "").slice(0, 100);
    if (!derived) {
      return { nextProduct: product, outcome: { written: false, reason: "cover 缺失且无法从 features/recommendation 推断 description，跳过自动补齐" } };
    }
    fallbackDescription = derived;
  } else if (!textValue(existingCover.description)) {
    return { nextProduct: product, outcome: { written: false, reason: "cover 缺少 description，跳过自动补齐" } };
  }

  const keywords = collectCoverSearchKeywords(product);
  if (!keywords || keywords.length === 0) {
    return { nextProduct: product, outcome: { written: false, reason: "无可用关键词，跳过自动补齐" } };
  }

  // 按有序去重的关键词逐一尝试：search 抛错 / 候选空 / candidate 不完整
  // 都要继续下一个；只有找到第一个 imageResolved=true 的完整候选才写回，
  // 保证不会因为第一个 keyword 没拿到图就丢掉第二个 POI 的好图。
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

    const candidate = pickFirstUsableCoverCandidate(result.candidates);
    if (!isCoverCandidateComplete(candidate)) {
      continue;
    }

    const nextCover = buildCtripLibraryCoverFromCandidate({
      existingCover,
      candidate,
      keyword,
      selectedAt: now(),
      fallbackDescription,
    });

    // 不动 product 其它子树，只覆盖 presentation.cover。
    const nextProduct: Record<string, unknown> = {
      ...product,
      presentation: {
        ...presentation,
        cover: nextCover,
      },
    };

    return {
      nextProduct,
      outcome: { written: true, reason: "已写入携程图库封面", keyword, imageId: candidate.imageId },
    };
  }

  // 全部 keyword 都没拿到完整候选：返回原 product 引用，避免污染 draft。
  // reason 同时记下尝试的 keyword 数和列表，方便 console.info 时一眼看到排查路径。
  return {
    nextProduct: product,
    outcome: {
      written: false,
      reason: `所有 ${keywords.length} 个关键词（${keywords.join("、")}）都失败或未拿到完整候选，跳过自动补齐`,
    },
  };
}