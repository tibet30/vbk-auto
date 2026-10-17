export interface DiagnosticEnvironment {
  appVersion: string;
  platform: string;
  arch: string;
  model?: string;
  provider?: string;
}
export type ProductIssueSource = "planning" | "entry";
export type ProductIssueState = "failed" | "paused" | "blocked" | "uncertain_write";
export type ProductIssueBlocker = "approval_precondition" | "authorization_denied" | "completion_blocked";

export interface ProductDiagnosticIssue {
  eventId: string;
  source: ProductIssueSource;
  state: ProductIssueState;
  stage: string;
  reason: string;
  occurredAt: string;
  blockerKind?: ProductIssueBlocker;
}
export interface ProductDiagnosticReport {
  schemaVersion: 2;
  clientId: string;
  name: string;
  environment: DiagnosticEnvironment;
  issue: ProductDiagnosticIssue;
}

/** Only used to drain already-persisted v1 outbox rows without sending their rich payload. */
export interface LegacyProductDiagnosticReport {
  schemaVersion: 1;
  clientId: string;
  name: string;
  creationInput?: unknown;
  environment: DiagnosticEnvironment;
  failure: {
    eventId: string;
    stage?: string;
    error: string;
    occurredAt: string;
  } | null;
}
