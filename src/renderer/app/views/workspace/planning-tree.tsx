/**
 * 三阶段产品规划树（PlanningTree）入口 barrel。
 *
 * 历史 importer 继续 `import { PlanningTree } from "./planning-tree.js"`，符号由
 * 子文件再聚合出去。
 *
 * 子模块：
 *   - constants.ts   STAGES / NODE_LABELS / RERUN_FALLBACK_NODES / STATUS_LABELS；
 *   - helpers.tsx    纯函数（resolveActivePlanningNode / statusIcon / overallLabel...）；
 *   - component.tsx  PlanningTree 主组件（含 JSX + adoption card / 弹窗接入）。
 */

export { PlanningTree } from "./planning-tree/component.js";
export type { PlanningTreeProps } from "./planning-tree/component.js";