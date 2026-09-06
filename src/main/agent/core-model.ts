import type { AgentModel, AgentModelInput, AgentModelResult } from "./types.js";

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value.toUpperCase() : "";
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

export function isTransientModelError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true;
  return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]
    .includes(errorCode(error));
}

/** One initial attempt plus two bounded retries for transient transport/provider failures. */
export async function completeWithRetries(
  model: AgentModel,
  input: AgentModelInput,
): Promise<AgentModelResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await model.complete(input);
    } catch (error) {
      if (attempt >= 2 || !isTransientModelError(error)) throw error;
      await input.onContent?.("");
    }
  }
}
