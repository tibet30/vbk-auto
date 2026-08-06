export class AutomationCancelledError extends Error {
  constructor(message = "用户中止了自动录入") {
    super(message);
    this.name = "AutomationCancelledError";
  }
}
