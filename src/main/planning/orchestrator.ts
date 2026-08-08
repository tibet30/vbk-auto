/**
 * 规划器接口：provider-neutral。Adapter 内部允许出现 transport 参数
 * （baseUrl / model / API key），但接口与 orchestrator / validator / prompt
 * builder 都看不到这些信息。
 */

import type {
  Planner,
  PlannerContext,
  PlannerRequest,
  PlanningStageOutput,
  PlanningStageError,
} from "../../shared/contracts-planning.js";
import { PlannerError } from "../../shared/contracts-planning.js";

export type { Planner, PlannerContext, PlannerRequest, PlanningStageOutput, PlanningStageError };

export function toPlannerError(error: unknown): PlannerError {
  if (error instanceof PlannerError) return error;
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message || "未知错误";
  const details = (error as { details?: string } | null)?.details;
  switch (code) {
    case "provider_not_configured":
    case "provider_connection":
    case "provider_timeout":
    case "provider_rate_limit":
    case "provider_authentication":
    case "invalid_model_output":
    case "empty_model_output":
      return new PlannerError(code, message, details);
    default:
      return new PlannerError("unknown", message, details);
  }
}