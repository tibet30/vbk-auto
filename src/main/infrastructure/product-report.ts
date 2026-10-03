import type { AutomationRun, ProductDetail } from "../../shared/contracts.js";
import { redactLogString, redactLogValue } from "../../shared/log-redaction.js";

/** Transport projection shared by create, update and mirror change detection.
 * Product JSON, conversations, research, planning and usage are durable business
 * state. Local journals and cache clocks are never part of that contract.
 */
export function productReport(product: ProductDetail): ProductDetail {
  const body = { ...product.product };
  const checkpointTime = product.automation ? automationCheckpointTime(product.automation) : undefined;
  if (body.diagnostics !== undefined) body.diagnostics = compactDiagnostics(body.diagnostics);
  return {
    id: product.id,
    name: product.name,
    status: product.status,
    updatedAt: product.updatedAt,
    product: body,
    messages: product.messages,
    researchTasks: product.researchTasks,
    ...(product.productId !== undefined ? { productId: product.productId } : {}),
    ...(product.vbkAccount !== undefined ? { vbkAccount: product.vbkAccount } : {}),
    ...(product.basicInfoSaved !== undefined ? { basicInfoSaved: product.basicInfoSaved } : {}),
    ...(product.planning ? { planning: product.planning } : {}),
    ...(product.aiUsage ? { aiUsage: product.aiUsage } : {}),
    ...(product.automation ? { automation: {
      id: product.automation.id,
      ...(checkpointTime ? { updatedAt: checkpointTime } : {}),
      status: product.automation.status,
      phases: product.automation.phases,
      logs: [], // Required by the legacy read contract; journal remains local.
      ...(product.automation.currentPhase ? { currentPhase: product.automation.currentPhase } : {}),
      ...(product.automation.recovery ? { recovery: product.automation.recovery } : {}),
      ...(product.automation.trafficLine ? { trafficLine: product.automation.trafficLine } : {}),
    } } : {}),
  };
}

/** Ignore transport/cache revisions and product clocks when detecting a change. */
export function sameProductReport(left: ProductDetail, right: ProductDetail): boolean {
  const comparable = (product: ProductDetail) => {
    const { updatedAt: _clock, ...report } = productReport(product);
    if (report.automation) {
      const { updatedAt: _runClock, ...checkpoint } = report.automation;
      report.automation = checkpoint;
    }
    return JSON.stringify(canonical(report));
  };
  return comparable(left) === comparable(right);
}

function automationCheckpointTime(run: AutomationRun): string | undefined {
  const attempts = Object.values(run.recovery?.phases ?? {}).flatMap(phase => [
    ...phase.attempts, ...(phase.attemptsHistory ?? []),
  ]);
  const times = [run.updatedAt, ...run.logs.map(log => log.at), ...attempts.map(attempt => attempt.at)]
    .filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)));
  return times.reduce<string | undefined>((latest, at) => !latest || Date.parse(at) > Date.parse(latest) ? at : latest, undefined);
}

/** Successful writes return remote business state plus this device's artifacts.
 * Conflict snapshots must stay untouched so callers can resolve against truth.
 */
export function withLocalProductArtifacts(saved: ProductDetail, local: ProductDetail): ProductDetail {
  return {
    ...saved,
    ...(local.executionTime ? { executionTime: local.executionTime } : {}),
    ...(local.productJsonVersion !== undefined ? { productJsonVersion: local.productJsonVersion } : {}),
    ...(saved.automation && saved.automation.id === local.automation?.id ? { automation: {
      ...saved.automation,
      logs: local.automation.logs,
      ...(local.automation.screenshot ? { screenshot: local.automation.screenshot } : {}),
    } } : {}),
  };
}

function pick(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

function compactDiagnostics(value: unknown): Record<string, unknown> {
  const source = pick(value, ["creationInput", "runtime", "debugSnapshot"]);
  const runtime = pick(source.runtime, ["status", "stage", "progress", "message", "error", "updatedAt", "lastToolFailure"]);
  const failure = pick(runtime.lastToolFailure, ["name", "arguments", "error", "occurredAt"]);
  if (typeof failure.name === "string" && typeof failure.error === "string") {
    const argumentsValue = redactLogValue(failure.arguments ?? {});
    const serialized = JSON.stringify(argumentsValue);
    runtime.lastToolFailure = {
      name: redactLogString(failure.name).slice(0, 120),
      arguments: serialized.length > 8_000 ? { truncated: true, preview: serialized.slice(0, 8_000) } : argumentsValue,
      error: redactLogString(failure.error).slice(0, 2_000),
      occurredAt: String(failure.occurredAt ?? "").slice(0, 40),
    };
  } else delete runtime.lastToolFailure;
  for (const key of ["message", "error"]) {
    if (typeof runtime[key] === "string") runtime[key] = redactLogString(runtime[key]).slice(0, 2_000);
  }
  return {
    ...(source.creationInput !== undefined ? { creationInput: pick(source.creationInput, ["destination", "productForm", "days", "userIdea"]) } : {}),
    ...(source.runtime !== undefined ? { runtime } : {}),
    ...(source.debugSnapshot !== undefined ? { debugSnapshot: pick(source.debugSnapshot, ["localProductId", "productId", "basicInfoSaved", "pendingInput", "pendingApproval", "uncertainWrite"]) } : {}),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
