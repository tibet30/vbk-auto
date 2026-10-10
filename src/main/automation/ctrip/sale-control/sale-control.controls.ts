/**
 * sale-control 模块的低层控件 helper（barrel）：
 *   - findRowByTitle 按 title 文本定位 saleControl-body 里的行；
 *   - waitForRowEnabledSelect 等合同启用的 ant-select 出现；
 *   - setEnabledSelectByLabel / setSplitGroupIfPresent / selectLineBrandFirstOption
 *     安全地点开 / 选下拉（异常走 skipped，不抛错以免阻塞后续阶段）；
 *   - checkAllEnabledDistributionChannels 批量勾选「分销渠道」，跳过途风、泛定制-C 与 disabled 项。
 *
 * 页面与定位器统一使用携程自动化的 Playwright 类型边界。
 *
 * 子文件分工：
 *   - controls/row-locator.ts：findRowByTitle / waitForRowEnabledSelect /
 *     rowHasSelectedLabel / waitForRowSelectedLabel；
 *   - controls/select.ts：setEnabledSelectByLabel；
 *   - controls/small-group.ts：setSmallGroupIfPresent /
 *     alternateSmallGroupInputValue / readSmallGroupState /
 *     smallGroupStateMatches；
 *   - controls/line-brand.ts：selectLineBrandFirstOption；
 *   - controls/distribution-channels.ts：
 *     DISTRIBUTION_CHANNELS_TO_SKIP / shouldSkipDistributionChannel /
 *     checkAllEnabledDistributionChannels。
 *
 * 同时暴露 setSplitGroupIfPresent 别名（历史导出名），保持调用方零改动。
 */

export {
  findRowByTitle,
  rowHasSelectedLabel,
  waitForRowEnabledSelect,
  waitForRowSelectedLabel,
} from "./controls/row-locator.js";

export { setEnabledSelectByLabel } from "./controls/select.js";

export {
  alternateSmallGroupInputValue,
  readSmallGroupState,
  setSmallGroupIfPresent,
  smallGroupStateMatches,
} from "./controls/small-group.js";
export { setSmallGroupIfPresent as setSplitGroupIfPresent } from "./controls/small-group.js";

export { selectLineBrandFirstOption } from "./controls/line-brand.js";

export {
  DISTRIBUTION_CHANNELS_TO_SKIP,
  shouldSkipDistributionChannel,
  checkAllEnabledDistributionChannels,
} from "./controls/distribution-channels.js";