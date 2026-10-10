/**
 * 携程图库图片搜索（直接 BrowserView fetch 版）barrel：
 *
 *   - 不再依赖 VBK 当前页「从图库资源导入」弹窗；
 *   - 链路分两阶段：
 *       阶段 A：searchCtripLibraryPlaces
 *         调 suggestPoi（soa2/15638/suggestpoi.json）按景点关键词解析 POI 列表；
 *         返回的 places 含 poiId / poiName / 可选 address / province / city /
 *         district；UI 在地址列表里选中一项后再走阶段 B；
 *       阶段 B：searchCtripLibraryImagesForPlace
 *         接收已选 place { poiId, ... }，调 searchImage（soa2/12719/searchImage）
 *         拿 imageIds，再用 fetchCtripImageInfoMap 拉详情（thumbnail / preview /
 *         score / resolution / poiName / ...）；
 *   - 旧入口 searchCtripLibraryImages 优先选择唯一精确同名 POI，
 *     没有精确同名时保留首项兼容行为。
 *
 * 子模块分工：
 *   - options.ts      SearchCtripLibraryOptions；
 *   - candidates.ts   buildPlaceCandidateFromPoi / buildCandidateFromImageInfo；
 *   - places.ts       阶段 A：searchCtripLibraryPlaces + 私有 callSuggestPoiPlaces；
 *   - images.ts       阶段 B：searchCtripLibraryImagesForPlace + 私有 callSearchImage；
 *   - wrapper.ts      旧兼容 searchCtripLibraryImages（两阶段一站式）。
 *
 * 调用方继续 `import {...} from "../ctrip-library-search.js"`，符号由下面
 * 4 行再聚合出去。
 */

export type { SearchCtripLibraryOptions } from "./ctrip-library-search/options.js";
export { searchCtripLibraryPlaces } from "./ctrip-library-search/places.js";
export { searchCtripLibraryImagesForPlace } from "./ctrip-library-search/images.js";
export { searchCtripLibraryImages } from "./ctrip-library-search/wrapper.js";

// 同时再聚合一下 protocol 里已有的同语义导出，保留旧调用方 `from ".../ctrip-library-search.js"` 的便利。
export {
  SUGGESTPOI_ENDPOINT,
  SEARCH_IMAGE_ENDPOINT,
  SEARCH_IMAGE_MAX_PAGE_SIZE,
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  buildSuggestPoiRequest,
  buildSearchImageRequest,
  parseSuggestPoiPayload,
  parseSuggestPoiPlaces,
  parseSearchImagePayload,
} from "./ctrip-library-protocol.js";