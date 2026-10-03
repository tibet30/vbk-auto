import { createHash } from "node:crypto";
import type { AgentSnapshot, CreateProductInput, ProductDetail } from "../../shared/contracts.js";
import type { DiagnosticEnvironment, ProductDiagnosticFailure, ProductDiagnosticReport } from "../../shared/product-diagnostic-report.js";
import { redactLogString, redactLogValue } from "../../shared/log-redaction.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown, limit: number) => redactLogString(typeof value === "string" ? value : "")
  .replace(/((?:authorization|password|passwd|secret|token|api.?key)["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s,;"'}]+/gi, "$1[已脱敏]")
  .slice(0, limit);
const eventId = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** A diagnostic contains original human input and failure facts, never the
 * generated product, conversation transcript, candidate pools or token ledger.
 */
export function buildProductDiagnostics(product: ProductDetail, environment: DiagnosticEnvironment, snapshot?: AgentSnapshot): ProductDiagnosticReport[] {
  const diagnostics = record(product.product.diagnostics);
  const original = record(diagnostics.creationInput);
  if (!original.destination || !original.productForm || !original.days) return [];
  const creationInput = {
    destination: text(original.destination, 200), productForm: original.productForm,
    days: original.days, ...(original.userIdea ? { userIdea: text(original.userIdea, 1000) } : {}),
  } as CreateProductInput;
  const base = { schemaVersion: 1 as const, clientId: product.id, name: product.name, creationInput, environment };
  const failures: ProductDiagnosticFailure[] = [];
  const events = snapshot?.events ?? [];
  const calls = new Map(events.filter(event => event.type === "tool_call" && typeof event.data?.toolCallId === "string")
    .map(event => [`${event.runId}:${event.data!.toolCallId}`, event]));
  let instruction = "";
  const runEnvironments = new Map<string, DiagnosticEnvironment>();
  for (const event of events) {
    if (event.type === "user") instruction = text(event.content, 2000);
    const usage = record(event.data?.aiUsage);
    if (usage.model) runEnvironments.set(event.runId, { ...environment, model: text(usage.model, 120), provider: text(usage.provider, 120) });
    if (event.type !== "tool_result" || typeof event.data?.error !== "string" || !event.data.error.trim()) continue;
    const call = calls.get(`${event.runId}:${event.data.toolCallId}`);
    failures.push({
      eventId: eventId([product.id, event.runId, event.id]), runId: event.runId,
      stage: text(call?.data?.phase ?? event.data.stage, 120) || "agent",
      tool: text(call?.data?.name ?? call?.content, 120), arguments: safeArguments(call?.data?.arguments),
      error: text(event.data.error, 2000), occurredAt: event.createdAt,
      ...(instruction ? { instruction } : {}), environment: runEnvironments.get(event.runId) ?? environment,
    });
  }
  if (snapshot?.run?.status === "failed" && snapshot.run.error
    && !failures.some(failure => failure.runId === snapshot.run!.id && failure.error === text(snapshot.run!.error, 2000))) {
    failures.push({ eventId: eventId([product.id, snapshot.run.id, "run-failed", snapshot.run.error]),
      runId: snapshot.run.id, stage: "agent", error: text(snapshot.run.error, 2000),
      occurredAt: snapshot.run.updatedAt, instruction, environment: runEnvironments.get(snapshot.run.id) ?? environment });
  }
  // Non-Agent and interrupted legacy workflows still have a compact error.
  const runtime = record(diagnostics.runtime);
  const failure = record(runtime.lastToolFailure);
  if (!snapshot?.run && (typeof failure.error === "string" || typeof runtime.error === "string")) {
    const error = text(failure.error ?? runtime.error, 2000);
    const occurredAt = text(failure.occurredAt ?? runtime.updatedAt ?? product.updatedAt, 40);
    if (error) failures.push({ eventId: eventId([product.id, occurredAt, failure.name, error]),
      stage: text(runtime.stage, 120), tool: text(failure.name, 120), arguments: safeArguments(failure.arguments),
      error, occurredAt, environment });
  }
  return [{ ...base, failure: null }, ...failures.map(failure => ({ ...base, failure }))];
}

function safeArguments(value: unknown): unknown {
  const serialized = JSON.stringify(redactLogValue(value ?? {}), (key, item) =>
    /password|passwd|secret|authorization|cookie|token|api.?key/i.test(key) ? "[已脱敏]" : item);
  const safe: unknown = JSON.parse(serialized);
  return serialized.length > 8000 ? { truncated: true, preview: serialized.slice(0, 8000) } : safe;
}
