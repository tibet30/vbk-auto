/** 自动化控制流异常：区分用户取消与不应交给 AI 诊断的确定性系统错误。 */

export class AutomationCancelledError extends Error {
  constructor(message = "用户中止了自动录入") {
    super(message);
    this.name = "AutomationCancelledError";
  }
}

/**
 * 页面已经明确证明目标数据不存在或系统配置不完整时使用。
 * recovery 必须保留并直接上抛，禁止交给 AI 猜测重试动作。
 */
export class NonAdvisableAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonAdvisableAutomationError";
  }
}

/**
 * 写请求发出前的确定性拦截（版本关系不可写等）。平台侧没有任何改动，
 * 不能被当作「写入结果不明」；同样不交给 AI 猜测重试。
 */
export class WriteNotDispatchedError extends NonAdvisableAutomationError {
  readonly writeDispatched = false;
  constructor(message: string) {
    super(message);
    this.name = "WriteNotDispatchedError";
  }
}
