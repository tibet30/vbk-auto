/**
 * 统一错误类。orchestrator 根据 code 决定是否重试；不暴露 provider 细节。
 */

export class PlannerError extends Error {
  constructor(
    public readonly code:
      | "provider_not_configured"
      | "provider_connection"
      | "provider_timeout"
      | "provider_rate_limit"
      | "provider_authentication"
      | "invalid_model_output"
      | "empty_model_output"
      | "missing_module"
      | "rejected_path"
      | "unknown",
    message: string,
    public readonly details?: string,
  ) {
    super(message);
  }
}