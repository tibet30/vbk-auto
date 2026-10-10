/**
 * suggestPoi 请求体构造 + 模块常量。
 *
 *   - buildPoiSuggestRequest：trim keyword → 固定 shape 的请求体；
 *
 * 这里不发请求，只是把请求体装配出来，便于单测。
 */

import type { PoiSuggestRequest } from "./types.js";

export function buildPoiSuggestRequest(keyword: string): PoiSuggestRequest {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("POI 关键词不能为空");
  return {
    requestHeader: { locale: "zh-CN" },
    poiTypes: [
      { key: 3, name: "SIGHT" },
      { key: 19, name: "EDUCATION" },
      { key: 66, name: "SIGHTPLAY" },
      { key: 99, name: "ACTIVITIES" },
    ],
    count: 100,
    keyword: trimmed,
    tagIds: [],
    useENameSort: "T",
    districtSortDto: { districtIds: [], poiIds: [] },
    contentType: "json",
  };
}