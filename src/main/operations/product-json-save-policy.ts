import { isDeepStrictEqual } from "node:util";
import type { ProductSummary } from "../../shared/contracts.js";

/** Restoring local verification metadata does not reopen a completed draft. */
export function productJsonSaveStatus(current: Record<string, unknown>, next: Record<string, unknown>, status: ProductSummary["status"]): ProductSummary["status"] {
  const { diagnostics: _currentDiagnostics, ...before } = current;
  const { diagnostics: _nextDiagnostics, ...after } = next;
  return isDeepStrictEqual(before, after) ? status : "review";
}
