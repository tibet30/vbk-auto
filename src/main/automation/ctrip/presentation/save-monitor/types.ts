/**
 * 「产品图文」保存 monitor 的对外契约：
 *   - SaveMonitorOutcome：成功 / 失败 / 敏感词的统一结果形状；
 *   - InstallOptions：超时配置；
 *   - PresentationSensitiveWordsError：平台明确返回敏感词时的结构化错误。
 *
 * 真实证据：保存按钮被点击后，VBK 页面会发起 `POST /15638/savedescriptioninfo`，
 * 携程 React store 的 editproductDesc 在被 UEditor setContent+sync 时未被同步写入
 * （详见 features.react-sync.ts 的注释），但 UI 仍会显示「保存成功」，目标 tab 也可能
 * 立刻被解锁；先于官方保存响应判定「保存完成」会让 saveThenAdvance 误判为 navigated。
 * 本模块把「保存成功」判定从「目标 tab 解锁」收窄为「官方 POST 响应 success=true 且
 * ResponseStatus.Ack=Success」。
 */

export interface SaveMonitorOutcome {
  /** 是否捕获到 success=true 且 ResponseStatus.Ack=Success 的官方保存响应。 */
  saved: boolean;
  /** 命中字段（用于诊断 + 测试断言；不允许做凭据相关回放）。 */
  httpStatus: number;
  ack: string;
  success: boolean;
  /** 命中敏感词列表（可能为空）。 */
  sensitiveWords: string[];
}

export interface InstallOptions {
  saveTimeoutMs?: number;
  sensitiveWordTimeoutMs?: number;
}

/**
 * 平台明确返回敏感词时使用的结构化错误。上层自动化据此触发 AI 局部重写，
 * 不再依赖解析面向运营的错误字符串。
 */
export class PresentationSensitiveWordsError extends Error {
  constructor(
    public readonly sensitiveWords: string[],
    public readonly httpStatus: number,
  ) {
    super(`产品图文触发敏感词，请先调整文案：${sensitiveWords.join("、")}（HTTP=${httpStatus}）`);
    this.name = "PresentationSensitiveWordsError";
  }
}