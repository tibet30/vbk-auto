import type { AgentSnapshot, CreateProductInput, ProductDetail, ProductWorkflowTask } from "../../shared/contracts.js";

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
  return mergeDiagnostics(product.product, {
    runtime: run ? {
      status: run.status,
      message: lastEvent?.content ? safeText(lastEvent.content, 400) : undefined,
      ...(run.error ? { error: safeText(run.error, 400) } : {}),
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
  return value.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").slice(0, max);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function definedDiagnostics(value: ProductDiagnostics): Partial<ProductDiagnostics> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<ProductDiagnostics>;
}
