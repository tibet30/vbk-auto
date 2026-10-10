/**
 * 封面 POI 候选并行查询 barrel：
 *
 *   - 用户输入单个关键词后，按 `${keyword}` / `${keyword}景区` /
 *     `${keyword}景点` / `${keyword}城市` 四个变体并行请求 suggestPoiDetail；
 *   - 合并结果，按 poiId 优先 / poiName 归一化 去重；
 *   - 给每个候选打上 kind（scenic / spot / city / keyword），便于 UI 行内展示；
 *   - 图片补全：从候选 textFields 提取 imageId，聚合后批量调 fetchCtripImageInfo。
 *
 * 子模块分工：
 *   - types.ts      对外契约（CoverPlaceBrowser / CoverPlaceSearchOptions / DEFAULT_VARIANTS）；
 *   - candidate.ts  buildCandidate + summariseTextFields + extractImageUrl + extractImageId；
 *   - merge.ts      图片回填 helpers（mergeImageInfo / stripUndefined / recordImageIdCandidate / normaliseName）；
 *   - search.ts     searchCoverPlaceCandidates 主入口。
 *
 * 调用方继续 `import {...} from "./cover-place-search.js"`，符号由下面这些行再聚合出去。
 */

export type {
  CoverPlaceImageInfoMap,
  CoverPlaceBrowser,
  CoverPlaceSearchOptions,
} from "./cover-place-search/types.js";
export { DEFAULT_VARIANTS } from "./cover-place-search/types.js";

export { searchCoverPlaceCandidates } from "./cover-place-search/search.js";

// 把 logger 桥接的几个工具 + 类型再透传出去（保持旧调用方 `from "..."` 路径）。
export { truncateImageIdsForLog } from "./cover-place-search-logger.js";
export type { CoverPlaceSearchLogEvent, CoverPlaceSearchLogger } from "./cover-place-search-logger.js";