/**
 * 携程图库协议类型：
 *   - CtripLibraryRequestHead：head 字段族（cid / ctok / cver / lang / sid …）；
 *   - SuggestPoiRequest / SearchImageRequest：两个接口的请求体；
 *   - SuggestPoiParsedPoi / SuggestPoiResponse / SuggestPoiPlacesResult：POI 解析结果；
 *   - SearchImageParsedItem / SearchImageResponse：图片 ID 解析结果；
 *   - CtripLibrarySearchBrowser：浏览器侧最小接口（只需 evaluate）。
 */

import type { PoiSuggestBrowser } from "../poi-suggest.js";

export interface CtripLibrarySearchBrowser
  extends Pick<PoiSuggestBrowser, "evaluate"> {}

/** 同 VBK SOA 其它接口的 head 字段族：cid 留空字符串，由 evaluate 内联读取 cookie 注入。 */
export interface CtripLibraryRequestHead {
  cid: string;
  ctok: string;
  cver: string;
  lang: string;
  sid: string;
  syscode: string;
  auth: string;
  xsid: string;
  extension: unknown[];
}

export interface SuggestPoiRequest {
  contentType: "json";
  head: CtripLibraryRequestHead;
  keyword: string;
  orderType: string;
}

export interface SearchImageRequest {
  contentType: "json";
  head: CtripLibraryRequestHead;
  tags: ReadonlyArray<{
    tagType: "District" | "PoiId" | "Country";
    tagValue: string;
  }>;
  sources: ReadonlyArray<number>;
  urlOptions: ReadonlyArray<{
    width: number;
    height: number;
    quality: number;
    type: string;
  }>;
  imageClass: string;
  pageIndex: number;
  pageSize: number;
  auditStatuses: ReadonlyArray<number>;
  excludeGif: boolean;
}

export interface SuggestPoiParsedPoi {
  /** 候选 POI ID（>0 的整数）。 */
  poiId: number;
  /** 候选 POI 名称；用于上层在 UI 显示「匹配到的景点」/ 写入 cover.poiName。 */
  poiName: string;
  /** 可选：完整地址文本。 */
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
}

export interface SuggestPoiResponse {
  httpStatus: number;
  businessStatus: string;
  poi: SuggestPoiParsedPoi | null;
}

/** suggestPoi 完整解析结果：阶段 A 把所有合法候选都返回给 UI 选地址。 */
export interface SuggestPoiPlacesResult {
  httpStatus: number;
  businessStatus: string;
  places: SuggestPoiParsedPoi[];
}

export interface SearchImageParsedItem {
  imageId: number;
}

export interface SearchImageResponse {
  httpStatus: number;
  businessStatus: string;
  imageIds: number[];
}