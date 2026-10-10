/**
 * 三阶段行程编排（runFoundationLocation → buildVerifiedPool → composeItinerary）
 * 入口 barrel。
 *
 * 历史 importer 继续 `import { runFoundationLocation, buildVerifiedPool, composeItinerary }
 * from "../three-stage-itinerary-flow.js"`；本文件按阶段把实现拆到子目录。
 *
 * 子模块：
 *   - types.ts                   共享依赖接口 + 私有 helper（fail/node/asRecord/text/...）；
 *   - foundation-location.ts     第一阶段：补齐省份；
 *   - verified-pool.ts           第二阶段：构建真实 POI 候选池（含多选项备选）；
 *   - compose.ts                 第三阶段：把 POI 池落盘为 itinerary。
 */

export { runFoundationLocation } from "./three-stage-itinerary-flow/foundation-location.js";
export { buildVerifiedPool } from "./three-stage-itinerary-flow/verified-pool.js";
export { composeItinerary } from "./three-stage-itinerary-flow/compose.js";
export type { ThreeStageItineraryDependencies } from "./three-stage-itinerary-flow/types.js";
export type { PatchNode } from "./three-stage-itinerary-flow/types.js";