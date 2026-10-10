/**
 * POI 候选查询（soa2/20049/suggestPoi）barrel。
 *
 * 暴露的"层次"对外调用方：
 *   - suggestPoi / suggestPoiDetail / suggestPoiDetailWithRawPayload / suggestPoiDemo：
 *     不同详细程度的派生入口；
 *   - buildPoiSuggestRequest / parsePoiSuggestPayload：请求体构造 + 离线解析；
 *   - PoiSuggestRequest / PoiSuggestTimeoutOptions / PoiSuggestTimeoutError 等。
 *
 * 子模块分工：
 *   - types.ts      请求 / 选项 / 错误类 / 模块常量；
 *   - request.ts    buildPoiSuggestRequest；
 *   - query.ts      私有 queryPoiSuggest + 精简 suggestPoiDemo（BrowserView evaluate fetch）；
 *   - parse.ts      parsePoiSuggestPayload（Ack 校验 + 提取 poiList）；
 *   - match.ts      pickBestPoi + 名字 / 行政区 / 别名匹配的 helpers；
 *   - derive.ts     suggestPoi / suggestPoiDetail / suggestPoiDetailWithRawPayload +
 *                   私有的 destinationCity 前缀兜底。
 *
 * 调用方继续 `import {...} from "./poi-suggest.js"`，符号由下面这些行再聚合出去。
 */

export type {
  PoiSuggestRequest,
  PoiDistrictSortDto,
  PoiSuggestDemoResult,
  PoiSuggestBrowser,
  PoiSuggestTimeoutOptions,
} from "./poi-suggest/types.js";
export { PoiSuggestTimeoutError } from "./poi-suggest/types.js";
export { SUGGEST_POI_ENDPOINT, POI_BROWSER_REQUEST_TIMEOUT_MS, POI_EVALUATE_TIMEOUT_MS } from "./poi-suggest/types.js";

export { buildPoiSuggestRequest } from "./poi-suggest/request.js";

export { suggestPoiDemo } from "./poi-suggest/query.js";

export { parsePoiSuggestPayload } from "./poi-suggest/parse.js";

export {
  suggestPoi,
  suggestPoiDetail,
  suggestPoiDetailWithRawPayload,
} from "./poi-suggest/derive.js";

export { pickBestPoi } from "./poi-suggest/match.js";

// 把 detail 层原 export 也透传出去（保持旧 API）。
export { flattenPoiTextFields } from "./poi-suggest-detail.js";