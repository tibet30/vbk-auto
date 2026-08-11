/**
 * 封面 POI 候选并行查询：
 *   - 用户输入单个关键词后，按 `${keyword}` / `${keyword}景区` /
 *     `${keyword}景点` / `${keyword}城市` 四个变体并行请求 suggestPoiDetail；
 *   - 合并结果，按 poiId 优先 / poiName 归一化 去重；
 *   - 给每个候选打上 kind（scenic / spot / city / keyword），便于 UI 行内展示；
 *   - **图片补全**：从候选 textFields 提取 imageId（多种 path 名），聚合后批量
 *     调 fetchCtripImageInfo（getImageInfo），把返回的 thumbnailUrl/previewUrl
 *     /score/resolution/poiName 回填到 candidate.imageUrl 与同名字段。
 *
 * 设计约束：
 *   - 不直接 import automation / cover-storage，避免循环依赖；
 *   - 单个 variant 失败不中断其它 variant，错误累加到 CoverPlaceSearchResult.errors；
 *   - 候选的 detail / rawText 由 suggestPoiDetail 返回的 textFields 派生，便于 UI
 *     展示「城市」/「省份」等附加信息；
 *   - imageId 缺失 / fetchCtripImageInfo 抛错 → 候选仍返回，UI 走占位图；
 *   - **可观测日志**：可选 logger 在关键节点发出结构化事件（search-start /
 *     candidates-after-dedup / image-ids-extracted / skip-image-info /
 *     image-info-request-start / image-info-success / image-info-failure），
 *     由 cover-ipc 注入 console.warn 桥接；测试可注入 spy / silent。
 *     payload **绝不**携带 cookie / header / token / 完整图片 URL 列表。
 *
 * 调用入口：
 *   - src/main/operations/cover-ipc.ts 的 searchCtripLibraryCoverCandidates
 *     （沿用 IPC 名以避免大量 preload / renderer 改动；语义已切换为 places 候选）。
 */
import type { PoiSuggestCandidate, PoiSuggestDetailResult } from "../../shared/contracts.js";
import type { CoverPlaceCandidate, CoverPlaceSearchResult } from "../../shared/contracts-types.js";
import type { CtripLibraryImageInfo } from "./ctrip-image-info.js";
import {
  EMPTY_COVER_PLACE_SEARCH_CONTEXT,
  SILENT_COVER_PLACE_LOGGER,
  truncateImageIdsForLog,
  type CoverPlaceSearchLogger,
} from "./cover-place-search-logger.js";

const DEFAULT_VARIANTS: ReadonlyArray<{ suffix: string; kind: CoverPlaceCandidate["kind"] }> = [
  { suffix: "景区", kind: "scenic" },
  { suffix: "景点", kind: "spot" },
  { suffix: "城市", kind: "city" },
];

/** 携程图库图片查询结果按 imageId 索引；非 Success Ack / 网络异常 → 抛错。 */
export type CoverPlaceImageInfoMap = ReadonlyMap<number, CtripLibraryImageInfo>;

export interface CoverPlaceBrowser {
  /** 复用 suggestPoiDetail 的 evaluate 路径；不要直接 import automation。 */
  suggestPoiDetail(keyword: string): Promise<PoiSuggestDetailResult>;
  /**
   * 批量查询 getImageInfo：cover 候选里抽到 imageId 时调用。
   *  - 可选：测试可注入 fake；未注入时 imageUrl 只走 textFields 兜底；
   *  - 抛错由 searchCoverPlaceCandidates 捕获并写到 errors，不让候选整体失败。
   */
  fetchCtripImageInfo?(imageIds: ReadonlyArray<number>): Promise<CoverPlaceImageInfoMap>;
}

export interface CoverPlaceSearchOptions {
  /** 自定义 keyword variants；缺省走 DEFAULT_VARIANTS + 原始 keyword。 */
  variants?: ReadonlyArray<{ suffix: string; kind: CoverPlaceCandidate["kind"] }>;
  /** 单 variant 提示性的并发上限；目前发 Promise.all，不分批。 */
  /**
   * 可选 logger：cover-ipc 在主进程注入 console.warn 桥接；测试可注入 spy / silent。
   * 不传 → no-op，保证零行为变化（纯函数默认仍可用）。
   */
  logger?: CoverPlaceSearchLogger;
  /**
   * getImageInfo endpoint，仅用于日志；默认走 ctrip-image-info 内置 endpoint。
   * 透传而不直接 import，避免基础设施层循环依赖。
   */
  imageInfoEndpoint?: string;
}

export { truncateImageIdsForLog } from "./cover-place-search-logger.js";
export type { CoverPlaceSearchLogEvent, CoverPlaceSearchLogger } from "./cover-place-search-logger.js";

/**
 * 给「一个 PoiSuggestCandidate + 来源 kind」推导 cover place candidate：
 *  - label / poiName：candidate.poiName（trim 后非空）；
 *  - detail：从 textFields 拼接最常见的 cityName / provinceName / address，
 *    便于 UI 行内显示「太原 · 山西 · 晋源区…」；
 *  - imageUrl：从 textFields 推导候选预览图，便于 UI 行内直接渲染缩略图；
 *  - imageId：从 textFields 提取（imageId / imageIds / coverImageId / coverIds /
 *    imgId / imgIds 等 path），由 searchCoverPlaceCandidates 后续批量补全真实 URL；
 *  - stableId：poiId 优先；否则用 normalized poiName，保证重复请求可去重；
 *  - 返回 null 表示该候选因 poiName 缺失不可写入 cover。
 */
function buildCandidate(candidate: PoiSuggestCandidate, kind: CoverPlaceCandidate["kind"]): CoverPlaceCandidate | null {
  const poiName = (candidate.poiName ?? "").trim();
  if (!poiName) return null;
  const detail = summariseTextFields(candidate.textFields);
  const imageUrl = extractImageUrl(candidate.textFields) ?? undefined;
  const imageId = extractImageId(candidate.textFields);
  const stableId = candidate.poiId !== null
    ? `poiId:${candidate.poiId}`
    : `name:${normaliseName(poiName)}`;
  return {
    stableId,
    label: poiName,
    poiName,
    poiId: candidate.poiId,
    kind,
    detail: detail || undefined,
    imageUrl,
    imageId: imageId ?? undefined,
  };
}

function summariseTextFields(fields: PoiSuggestCandidate["textFields"]): string {
  const order = ["cityName", "districtName", "provinceName", "address"];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    const field = fields.find((item) => item.path === key && !seen.has(item.value));
    if (field) {
      parts.push(field.value);
      seen.add(field.value);
    }
  }
  // 兜底：若常见字段都没拿到，把前 3 个不同文本字段补上。
  if (parts.length === 0) {
    for (const field of fields) {
      if (seen.has(field.value)) continue;
      if (!field.value || /^\d+$/.test(field.value)) continue;
      parts.push(field.value);
      seen.add(field.value);
      if (parts.length >= 3) break;
    }
  }
  return parts.join(" · ");
}

/** path 上的图片字段提示（image / img / photo / pic / cover / thumb / url）。 */
const IMAGE_PATH_HINT = /image|img|photo|pic|cover|thumb|url/i;
/** value 必须是 http(s) 链接才视为图片 URL。 */
const IMAGE_VALUE_HINT = /^https?:\/\//;
/** value 末尾（query / hash 之前）扩展名是常见图片格式。 */
const IMAGE_EXT_HINT = /\.(?:jpe?g|png|webp|gif|bmp|avif|svg)(?:\?|#|$)/i;
/** 携程图片域名兜底：images*.c-ctrip.com / you.ctrip.com 等。 */
const CTRIP_IMAGE_HOST = /(?:^|\.)(?:images\d*\.c-ctrip\.com|you\.ctrip\.com|images\.trip\.com|trip\.cn)/i;

/** imageId 字段 path 提示（path 末段含 imageId 即可，不管多深）。 */
const IMAGE_ID_PATH_HINT = /(?:^|\.)(?:imageid|imageids|coverimageid|coverimageids|coverid|coverids|imgid|imgids|picid|picids|photoid|photoids|coverpicid|coverpicids)(?:\[\d+\]|\.\d+)*$/i;

/**
 * 单字段判断：value 是否像是图片 URL。
 *  - 命中规则 1：path 含图片字段提示 + value 是 http(s) 链接；
 *  - 命中规则 2（兜底）：value 是 http(s) 链接，且扩展名是图片格式 / 落在携程图片域名上。
 *  - 任意一条满足即返回 true。
 */
function isLikelyImageUrl(path: string, value: string): boolean {
  if (!value || !IMAGE_VALUE_HINT.test(value)) return false;
  if (IMAGE_PATH_HINT.test(path)) return true;
  return IMAGE_EXT_HINT.test(value) || CTRIP_IMAGE_HOST.test(value);
}

/**
 * 从 textFields 里挑一张「最像预览图」的 URL：
 *  - 第一轮按 path 匹配（image|img|photo|pic|cover|thumb|url）+ value 必须是 http(s)；
 *  - 第二轮（兜底）只要 value 是 http(s) 且扩展名 / 域名命中图片库。
 *  - 没有命中返回 null，让调用方决定是写 undefined 还是忽略字段。
 */
function extractImageUrl(fields: PoiSuggestCandidate["textFields"]): string | null {
  for (const field of fields) {
    if (IMAGE_PATH_HINT.test(field.path) && IMAGE_VALUE_HINT.test(field.value)) {
      return field.value;
    }
  }
  for (const field of fields) {
    if (isLikelyImageUrl(field.path, field.value)) {
      return field.value;
    }
  }
  return null;
}

/**
 * 从 textFields 提取 imageId：
 *  - path 末段命中 imageId/imageIds/coverImageId/coverIds/imgId/imgIds/picId/picids/photoId 等；
 *  - value 是数字或逗号 / 空格分隔的数字数组 → 取首个正整数；
 *  - 没命中返回 null（不抛错，让候选走占位）。
 *
 * 设计：携程 suggestPoi 真实响应里 imageId 经常出现在 `extend[].imageId` 这种
 * 嵌套 path 里，所以用 path.endsWith 风格的判断允许任意深度。
 */
function extractImageId(fields: PoiSuggestCandidate["textFields"]): number | null {
  for (const field of fields) {
    if (!IMAGE_ID_PATH_HINT.test(field.path)) continue;
    const value = `${field.value ?? ""}`.trim();
    if (!value) continue;
    // 兼容数组形态 "123,456" / "123 456" / JSON 数组 "[123,456]"。
    const tokens = value
      .replace(/^\[|\]$/g, "")
      .split(/[,\s/;]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of tokens) {
      const parsed = Number(token);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

/**
 * 并行请求 + 去重 + 图片补全 的核心逻辑（纯函数，便于 tsx --test）。
 * 接受一个注入式的浏览器 invoker，单元测试时换成 fake。
 */
export async function searchCoverPlaceCandidates(
  browser: CoverPlaceBrowser,
  keyword: string,
  options: CoverPlaceSearchOptions = {},
): Promise<CoverPlaceSearchResult> {
  const logger = options.logger ?? SILENT_COVER_PLACE_LOGGER;
  const endpoint = options.imageInfoEndpoint ?? "";
  const trimmed = keyword.trim();
  if (!trimmed) {
    return { keyword: "", candidates: [], errors: [], fetchedAt: new Date().toISOString() };
  }
  logger({ event: "search-start", keyword: trimmed });
  const variants = options.variants ?? DEFAULT_VARIANTS;
  // 并行请求：原始 keyword（kind=keyword）+ 每个 variant。
  const tasks: Array<{ kind: CoverPlaceCandidate["kind"]; promise: Promise<PoiSuggestDetailResult> }> = [
    { kind: "keyword", promise: browser.suggestPoiDetail(trimmed) },
    ...variants.map((variant) => ({
      kind: variant.kind,
      promise: browser.suggestPoiDetail(`${trimmed}${variant.suffix}`),
    })),
  ];
  const settled = await Promise.allSettled(tasks.map((task) => task.promise));
  const errors: CoverPlaceSearchResult["errors"] = [];
  const deduped = new Map<string, CoverPlaceCandidate>();
  // imageId → 候选 key 列表：用于一次 fetchCtripImageInfo 后回填多候选。
  const imageIdToCandidateKeys = new Map<number, string[]>();
  settled.forEach((result, index) => {
    const { kind } = tasks[index];
    const variantLabel = kind === "keyword" ? trimmed : `${trimmed}${variants[index - 1]?.suffix ?? ""}`;
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason ?? "未知错误");
      errors.push({ variant: variantLabel, message });
      return;
    }
    const detail = result.value;
    for (const candidate of detail.candidates) {
      const built = buildCandidate(candidate, kind);
      if (!built) continue;
      const key = built.poiId !== null ? `poiId:${built.poiId}` : `name:${normaliseName(built.poiName)}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, built);
        recordImageIdCandidate(imageIdToCandidateKeys, built, key);
        continue;
      }
      // 同名/同 id：保留 kind 优先级 keyword > scenic > spot > city，
      // 这样原始关键词的命中信息最丰富，最贴近运营意图。
      const priority = { keyword: 0, scenic: 1, spot: 2, city: 3 } as const;
      if (priority[built.kind] < priority[existing.kind]) {
        // 替换优先级：existing 上的 imageUrl / imageId / detail 不要丢。
        const merged: CoverPlaceCandidate = {
          ...built,
          detail: built.detail ?? existing.detail,
          imageUrl: built.imageUrl ?? existing.imageUrl,
          imageId: built.imageId ?? existing.imageId,
          score: built.score ?? existing.score,
          resolution: built.resolution ?? existing.resolution,
          imageInfoPoiId: built.imageInfoPoiId ?? existing.imageInfoPoiId,
          imageInfoPoiName: built.imageInfoPoiName ?? existing.imageInfoPoiName,
        };
        deduped.set(key, merged);
        recordImageIdCandidate(imageIdToCandidateKeys, merged, key);
      } else {
        // 只补缺字段：existing 没图但 built 有图时一并补上。
        const merged: CoverPlaceCandidate = {
          ...existing,
          detail: existing.detail ?? built.detail,
          imageUrl: existing.imageUrl ?? built.imageUrl,
          imageId: existing.imageId ?? built.imageId,
          score: existing.score ?? built.score,
          resolution: existing.resolution ?? built.resolution,
          imageInfoPoiId: existing.imageInfoPoiId ?? built.imageInfoPoiId,
          imageInfoPoiName: existing.imageInfoPoiName ?? built.imageInfoPoiName,
        };
        deduped.set(key, merged);
        recordImageIdCandidate(imageIdToCandidateKeys, merged, key);
      }
    }
  });

  // 图片补全：聚合所有候选的 imageId（去重）→ 一次 fetchCtripImageInfo → 回填。
  const aggregatedImageIds = [...imageIdToCandidateKeys.keys()];
  // 中间观察点：候选合并去重完成后立即打日志，方便排查「无候选 / 无 imageId」类问题。
  logger({
    event: "candidates-after-dedup",
    candidateCount: deduped.size,
    withImageIdCount: aggregatedImageIds.length,
    imageIds: truncateImageIdsForLog(aggregatedImageIds),
  });
  if (aggregatedImageIds.length > 0 && browser.fetchCtripImageInfo) {
    logger({
      event: "image-ids-extracted",
      imageIds: truncateImageIdsForLog(aggregatedImageIds),
    });
    logger({
      event: "image-info-request-start",
      imageIds: truncateImageIdsForLog(aggregatedImageIds),
      endpoint,
    });
    const requestStart = Date.now();
    try {
      const infoMap = await browser.fetchCtripImageInfo(aggregatedImageIds);
      const durationMs = Date.now() - requestStart;
      const itemCount = infoMap.size;
      // 仅向 logger 汇报条目数 / imageId 计数 / 耗时；具体 URL 列表由 cover-ipc
      // 在主进程侧重新走 ack / status 推导，避免误传。
      logger({
        event: "image-info-success",
        httpStatus: 200,
        ack: "Success",
        itemCount,
        imageIdCount: aggregatedImageIds.length,
        durationMs,
        // 当前路径未携带 cookie 上下文：cover-place-search 内部 evaluate 暂未
        // 收集 ctx；与 ctrip-library-search 的 suggest-failure 异常分支一致，
        // 走 EMPTY 兜底，不输出虚假信号。
        ctx: EMPTY_COVER_PLACE_SEARCH_CONTEXT,
      });
      for (const [imageId, candidateKeys] of imageIdToCandidateKeys.entries()) {
        const info = infoMap.get(imageId);
        if (!info) continue;
        const merged = mergeImageInfo(info);
        for (const candidateKey of candidateKeys) {
          const current = deduped.get(candidateKey);
          if (!current) continue;
          // 只覆盖 getImageInfo 真的给出值的字段：null/undefined 不得清空
          // 已有的 textFields 兜底（否则拿到半空 item 时缩略图反而丢了）。
          deduped.set(candidateKey, { ...current, ...stripUndefined(merged) });
        }
      }
    } catch (error) {
      const durationMs = Date.now() - requestStart;
      const message = error instanceof Error ? error.message : String(error ?? "未知错误");
      logger({
        event: "image-info-failure",
        message,
        httpStatus: 0,
        durationMs,
        // image-info-failure 发生在 fetchCtripImageInfo 抛出后，调用方拿不到
        // HTTP 状态；httpStatus=0 表示"未取得 HTTP 状态"，与同工程 image-info-success
        // 路径（HTTP 200，但无 cookie 上下文）使用 EMPTY 兜底保持一致。
        ctx: EMPTY_COVER_PLACE_SEARCH_CONTEXT,
      });
      errors.push({ variant: "getImageInfo", message: `图片详情查询失败：${message}` });
    }
  } else if (!browser.fetchCtripImageInfo) {
    // 没注入 fetchCtripImageInfo：留 events 给调用方感知（不算「跳过」）。
    logger({
      event: "skip-image-info",
      reason: "fetchCtripImageInfo 未注入（仅靠 textFields 兜底）",
      candidateCount: deduped.size,
    });
  } else {
    logger({
      event: "skip-image-info",
      reason: "no imageIds from suggestPoi candidates",
      candidateCount: deduped.size,
    });
  }

  const candidates = [...deduped.values()].sort((a, b) => {
    const priority = { keyword: 0, scenic: 1, spot: 2, city: 3 } as const;
    if (priority[a.kind] !== priority[b.kind]) return priority[a.kind] - priority[b.kind];
    return a.label.length - b.label.length || a.label.localeCompare(b.label, "zh-CN");
  });
  return {
    keyword: trimmed,
    candidates,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 记录候选的 imageId → candidateKey 反向索引，用于 fetchCtripImageInfo 后回填。
 * 无 imageId 时跳过；同一 imageId 对应多候选（同名候选跨 variant 命中）一并记录。
 */
function recordImageIdCandidate(
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

/**
 * 把 CtripLibraryImageInfo 转成可合并到候选的字段集合：
 *  - imageId：getImageInfo 返回的图片主键；与 textFields 抽到的 imageId 通常一致，
 *    但仍显式回填（兼容 textFields 缺 imageId / 浏览器端返回额外字段的边界）。
 *  - imageUrl：优先 thumbnailUrl（200 档），缺失回退 previewUrl（500 档），再缺失 originalUrl；
 *  - score / resolution / imageInfoPoiId / imageInfoPoiName：原样映射。
 */
function mergeImageInfo(info: CtripLibraryImageInfo): Partial<CoverPlaceCandidate> {
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
function stripUndefined(value: Partial<CoverPlaceCandidate>): Partial<CoverPlaceCandidate> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<CoverPlaceCandidate>;
}

function normaliseName(name: string): string {
  return name.replace(/[（）()\s]/g, "").toLowerCase();
}
