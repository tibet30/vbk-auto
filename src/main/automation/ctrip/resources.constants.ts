// @ts-nocheck
/**
 * 资源配置阶段共享的默认超时常量。
 * 集中在这里便于 review：所有「默认时长」必须显式列在测试或调用方可注入的
 * options.timeoutMs 之下，避免代码各处散落 magic number。
 */

/** 等待 .ResourceConfig-content-card 含「住宿晚数」段出现的默认超时（毫秒）。 */
export const DEFAULT_HOTEL_RESOURCE_CARD_TIMEOUT_MS = 12_000;

/** 等待「附加资源」入口异步渲染的默认超时（毫秒）。 */
export const DEFAULT_VEHICLE_RESOURCE_ENTRY_TIMEOUT_MS = 12_000;

/** 点击「编辑」后等「保存 / 提交」按钮变为可见的默认超时（毫秒）。 */
export const DEFAULT_RESOURCE_EDIT_TIMEOUT_MS = 4_000;

/** 点击「提交」后等目标资源行出现的默认超时（毫秒）—— 证明前向进度。 */
export const DEFAULT_VEHICLE_SUBMIT_TIMEOUT_MS = 8_000;

/** 点击「提交审核」后等「校验」弹窗出现的默认超时（毫秒）。 */
export const DEFAULT_VALIDATION_DIALOG_TIMEOUT_MS = 10_000;

/** 进入「校验」弹窗后等「校验结束」文本出现的默认超时（毫秒）。 */
export const DEFAULT_VALIDATION_RESULT_TIMEOUT_MS = 15_000;

/** 「选择资源组」弹窗内 groupId 查询行的可见性等待默认超时（毫秒）。 */
export const DEFAULT_RESOURCE_QUERY_TIMEOUT_MS = 6_000;