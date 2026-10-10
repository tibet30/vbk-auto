/**
 * 右侧 review 面板的「基础信息」编辑模块专用 action barrel。
 *
 * 主要能力：
 *   - 拉取当前账号的 AccountFixedInfo.butlerName 默认联系人 + 400 电话（loadAccountFixedInfo）；
 *   - per-field saving（lock + error + draft clear）：副标题 / 管家 / 价格三件套 /
 *     库存 / 用车总成本 / 封面；
 *   - AI 单字段重新生成（regenerateSubtitle）；
 *   - 封面手动上传 / 携程图库候选；
 *
 * 实现约束：
 *   - per-field saving 锁：避免运营连续点击同一字段造成 race；
 *   - per-field error 文案：保存失败时贴回 UI 红错并保留用户已输入的草稿；
 *   - 严禁编造但 booker / 资源组 ID：butler 必须来自 AccountFixedInfo，
 *     资源组 ID 必须由 VBK 真实匹配得到，UI 不允许自由输入。
 *
 * 子模块分工：
 *   - types.ts                  UpdateField + fieldLabel；
 *   - update-field.ts           makeUpdateField（带锁 + 错误贴回的 IPC 写）；
 *   - fixed-info.ts             makeLoadAccountFixedInfo + makeResetLoaded；
 *   - subtitle.ts               makeSaveSubtitle + makeRegenerateSubtitle；
 *   - butler-pricing-inventory.ts  makeSaveButler + makeSavePricing + makeSaveInventory；
 *   - vehicle.ts                makeSaveVehicleResourceField + makeSaveVehicleCost + makeSaveVehicleCostAndResolve；
 *   - cover.ts                  makeUploadAndSaveManualCover + makeSaveCtripLibraryCover + makeClearCover；
 *   - errors.ts                 makeClearError + makeClearAllErrors；
 *   - use-handlers.ts           useBasicInfoHandlers（顶层 hook，组合以上 8 个 factory）。
 *
 * 调用方继续 `import { useBasicInfoHandlers } from "../actions/basic-info.js"`，符号
 * 由下面这一行再聚合出去。
 */

export { useBasicInfoHandlers } from "./basic-info/use-handlers.js";
export type { UpdateField } from "./basic-info/types.js";
export { fieldLabel } from "./basic-info/types.js";