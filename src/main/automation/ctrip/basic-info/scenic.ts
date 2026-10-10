/**
 * 基本信息 → 国家景区的省份、景区与景点写入 barrel。
 *
 * 历史 importer 继续 `import { fillScenicAreaProvince, fillScenicAreaSpots } from
 * "./scenic.js"`，子文件按职责切分后保持路径不变。
 *
 * 子模块：
 *   - constants.ts   直辖市集合 + 搜索轮询超时；
 *   - province.ts    fillScenicAreaProvince（省份下拉选择，含 AI 兜底）；
 *   - spots.ts       fillScenicAreaSpots（4 级级联下拉逐项添加 + 实时 ≤ 3 校验）。
 */

export { fillScenicAreaProvince } from "./scenic/province.js";
export { fillScenicAreaSpots } from "./scenic/spots.js";