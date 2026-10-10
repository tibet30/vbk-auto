/**
 * 单 PoiSuggestCandidate → CoverPlaceCandidate 的派生：
 *   - buildCandidate：从 PoiSuggestCandidate 派生 label / detail / imageUrl / imageId / stableId；
 *   - summariseTextFields：拼接 cityName / districtName / provinceName / address；
 *   - extractImageUrl / extractImageId：从 textFields 抽 URL 和 imageId；
 *   - 私有的 regex 常量（IMAGE_PATH_HINT / IMAGE_VALUE_HINT / IMAGE_EXT_HINT / CTRIP_IMAGE_HOST / IMAGE_ID_PATH_HINT）。
 */

import type { PoiSuggestCandidate } from "../../../shared/contracts.js";
import type { CoverPlaceCandidate } from "../../../shared/contracts-types.js";

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
export function buildCandidate(candidate: PoiSuggestCandidate, kind: CoverPlaceCandidate["kind"]): CoverPlaceCandidate | null {
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

function normaliseName(name: string): string {
  return name.replace(/[（）()\s]/g, "").toLowerCase();
}