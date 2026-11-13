/**
 * VBK 登录态失效的统一识别：
 *   - 平台在线接口在 Cookie 过期后仍返回 HTTP 200，只在 ResponseStatus.Errors 里给出
 *     ErrorCode 10007/10009 与「当前用户登录已失效，请重新登录」「凭证无效」等文案；
 *   - 这类失败与网络 / 协议 / 业务校验错误不同，重试同一请求不可能恢复，必须由运营
 *     重新登录；按普通业务失败处理只会得到「Ack=Failure」这种无语义报错，任务还会
 *     白跑一轮模型调用才暂停；
 *   - 正则统一收口在此，避免每条 VBK 链路各写一份。
 */

const LOGIN_EXPIRED_PATTERN = /未登录|登录已失效|登录已过期|登录态[^，。；]*失(?:效|去)|凭证无效/i;

/** 文案是否指向 VBK 登录态失效（而非网络 / 协议 / 业务校验失败）。 */
export function isVbkLoginExpiredMessage(message: string): boolean {
  return LOGIN_EXPIRED_PATTERN.test(message);
}

/** 面向运营的固定处置话术：登录失效类失败只有重新登录才能恢复。 */
export const VBK_LOGIN_EXPIRED_HINT = "VBK 登录已失效，请重新登录 VBK 账号后继续。";

/**
 * 追加固定处置话术；消息里已经带过就不再重复。
 *
 * 同一条错误会先后经过平台链路（`failureMessage`）和工具回传
 * （`formatToolFailureForModel`）两层，两层各自追加会让模型收到两句完全相同的
 * 处置指引，白占上下文且读起来像两个不同的问题。
 */
export function withVbkLoginHint(message: string): string {
  return message.includes(VBK_LOGIN_EXPIRED_HINT) ? message : `${message}${VBK_LOGIN_EXPIRED_HINT}`;
}
