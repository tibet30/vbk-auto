/**
 * 「用户取消」专用的业务异常：用户点停止时抛出，被 recovery 状态机吞掉并切换到 cancelled 分支，
 * 与普通 failed 路径区分；UI 上显示「已停止」标签。
 */

export class AutomationCancelledError extends Error {
  constructor(message = "用户中止了自动录入") {
    super(message);
    this.name = "AutomationCancelledError";
  }
}
