import type { CreateProductInput } from "./contracts.js";

export interface DiagnosticEnvironment {
  appVersion: string;
  platform: string;
  arch: string;
  model?: string;
  provider?: string;
}
export interface ProductDiagnosticFailure {
  eventId: string;
  runId?: string;
  stage?: string;
  tool?: string;
  arguments?: unknown;
  error: string;
  occurredAt: string;
  instruction?: string;
  environment: DiagnosticEnvironment;
}
export interface ProductDiagnosticReport {
  schemaVersion: 1;
  clientId: string;
  name: string;
  creationInput: CreateProductInput;
  environment: DiagnosticEnvironment;
  failure: ProductDiagnosticFailure | null;
}
