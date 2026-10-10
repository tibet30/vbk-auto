/**
 * VBK 用车资源组查询与匹配（barrel）：
 *   - buildVehicleResourceQuery：把城市 / 天数 / 座位 / 车级 / 时长拼成搜索关键字；
 *   - extractResourceGroups / firstResourceGroup / bestResourceGroup：广撒网挑第一条 / 按预算挑最贴；
 *   - resolveVehicleResource：主入口，整体在 VBK 接口里选一份真实资源组写入产品。
 *
 * 子文件分工：
 *   - helpers.ts：positiveInteger / positiveNumber / roundUpVehicleTotalCost /
 *     textValue / firstText / firstNumber / escapeRegExp / normalisedText；
 *   - types.ts：对外类型（VehicleResourceEstimateInput / VehicleResourceQuery /
 *     ResolvedVehicleResource）；
 *   - query.ts：buildVehicleResourceQuery / targetVehicleTotalCost / sanitiseVehicleResource；
 *   - parse.ts：extractResourceGroups / firstResourceGroup / bestResourceGroup /
 *     parseVehicleResourceGroupNamePrice / parseResourceGroup；
 *   - search.ts：searchVehicleResourceGroups（fetch VBK /restapi/soa2/15638/searchResourceGroup）；
 *   - resolve.ts：resolveVehicleResource 主入口（含精准 → 兜底 → 人工介入三档策略）。
 */

export type {
  VehicleResourceEstimateInput,
  VehicleResourceQuery,
  ResolvedVehicleResource,
} from "./vehicle-resource/types.js";

export {
  positiveInteger,
  positiveNumber,
  roundUpVehicleTotalCost,
  textValue,
  firstText,
  firstNumber,
  escapeRegExp,
  normalisedText,
} from "./vehicle-resource/helpers.js";

export {
  buildVehicleResourceQuery,
  targetVehicleTotalCost,
  sanitiseVehicleResource,
} from "./vehicle-resource/query.js";

export {
  extractResourceGroups,
  firstResourceGroup,
  bestResourceGroup,
  parseVehicleResourceGroupNamePrice,
} from "./vehicle-resource/parse.js";

export { searchVehicleResourceGroups } from "./vehicle-resource/search.js";

export { resolveVehicleResource } from "./vehicle-resource/resolve.js";