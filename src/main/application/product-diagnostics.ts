import type { AgentSnapshot, CreateProductInput, ProductDetail, ProductWorkflowTask } from "../../shared/contracts.js";
import { redactLogString, redactLogValue } from "../../shared/log-redaction.js";

type ProductJson = Record<string, unknown>;
type DebugSnapshot = NonNullable<ProductDiagnostics["debugSnapshot"]>;

export interface ProductDiagnostics {
  creationInput?: {
    destination: string;
    productForm: string;
    days: number;
    userIdea?: string;
  };
  runtime?: {
    status: string;
    stage?: string;
    progress?: number;
    message?: string;
    error?: string;
    lastToolFailure?: {
      name: string;
      arguments: unknown;
      error: string;
      occurredAt: string;
    };
    updatedAt: string;
  };
  debugSnapshot?: {
    localProductId: string;
    productId?: string;
    basicInfoSaved?: boolean;
    pendingInput?: boolean;
    pendingApproval?: boolean;
    uncertainWrite?: boolean;
  };
}

export function creationDiagnostics(
  input: CreateProductInput,
): ProductDiagnostics {
  const userIdea = typeof input.userIdea === "string" ? input.userIdea.trim() : "";
  return {
    creationInput: {
      destination: String(input.destination ?? "").trim(),
      productForm: input.productForm,
      days: Number(input.days),
      ...(userIdea ? { userIdea } : {}),
    },
  };
}

export function mergeWorkflowTaskDiagnostics(product: ProductDetail, task: ProductWorkflowTask): ProductJson {
  return mergeDiagnostics(product.product, {
    runtime: {
      status: task.status,
      stage: task.stage,
      progress: task.progress,
      message: task.message,
      ...(task.error ? { error: task.error } : {}),
      updatedAt: task.updatedAt,
    },
    debugSnapshot: buildDebugSnapshot(product),
  });
}

export function mergeAgentDiagnostics(product: ProductDetail, snapshot: AgentSnapshot): ProductJson {
  const run = snapshot.run;
  const lastEvent = snapshot.events.at(-1);
  const debugSnapshot = buildDebugSnapshot(product);
  const failure = lastToolFailure(snapshot);
  return mergeDiagnostics(product.product, {
    runtime: run ? {
      status: run.status,
      message: lastEvent?.content ? safeText(lastEvent.content, 400) : undefined,
      ...(run.error ? { error: safeText(run.error, 400) } : {}),
      ...(failure ? { lastToolFailure: failure } : {}),
      updatedAt: run.updatedAt,
    } : undefined,
    debugSnapshot: {
      ...debugSnapshot,
      pendingInput: Boolean(snapshot.pendingInput),
      pendingApproval: Boolean(snapshot.pendingApproval),
      uncertainWrite: Boolean(snapshot.uncertainWrite),
    },
  });
}

function mergeDiagnostics(product: ProductJson, patch: ProductDiagnostics): ProductJson {
  const current = record(product.diagnostics);
  return {
    ...product,
    diagnostics: {
      ...current,
      ...definedDiagnostics(patch),
    },
  };
}

function buildDebugSnapshot(product: ProductDetail): DebugSnapshot {
  return {
    localProductId: product.id,
    ...(product.productId ? { productId: product.productId } : {}),
    ...(product.basicInfoSaved !== undefined ? { basicInfoSaved: product.basicInfoSaved } : {}),
  };
}

function safeText(value: string, max: number): string {
  return redactLogString(value).slice(0, max);
}

function lastToolFailure(snapshot: AgentSnapshot): NonNullable<NonNullable<ProductDiagnostics["runtime"]>["lastToolFailure"]> | undefined {
  if (!snapshot.run) return undefined;
  for (const result of [...snapshot.events].reverse()) {
    if (result.runId !== snapshot.run.id || result.type !== "tool_result" || typeof result.data?.error !== "string") continue;
    const call = snapshot.events.find((event) => event.runId === result.runId && event.type === "tool_call"
      && event.data?.toolCallId === result.data?.toolCallId);
    if (!call) continue;
    const name = typeof call.data?.name === "string" ? call.data.name : call.content;
    const safeArguments = redactLogValue(call.data?.arguments ?? {});
    const serialized = JSON.stringify(safeArguments);
    return {
      name: safeText(name, 120),
      arguments: serialized.length > 8_000 ? { truncated: true, preview: serialized.slice(0, 8_000) } : safeArguments,
      error: safeText(result.data.error, 2_000),
      occurredAt: result.createdAt,
    };
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function definedDiagnostics(value: ProductDiagnostics): Partial<ProductDiagnostics> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<ProductDiagnostics>;
}
