import type { AgentDisplaySnapshot } from './contracts-agent.js';
import type { ProductDetail, ProductReadiness } from './contracts-types/product.js';
import type { ProductWorkflowTask } from './contracts-types/workflow.js';

export type ProductPlan = Record<string, unknown>;
export interface ProductResourceEvidence {
  version: 1;
  source: 'legacy' | 'verified';
  diagnosticsPresent?: boolean;
  observations?: Array<import('./contracts-platform-operations.js').PlatformEvidence & { status: string }>;
  /** Paths refer to the compatible product projection, never a second plan. */
  fields: Array<{ path: string[]; value: unknown }>;
}
export interface ProductExecutionView {
  stage: string;
  pauseReason?: string;
  nextAction: 'wait' | 'provide_input' | 'approve' | 'resume' | 'verify_write' | 'none';
  resumePhase?: string;
  mother: 'pending' | 'verified';
  children: Array<{ id: string; verified: boolean; reason?: string }>;
  task?: ProductWorkflowTask;
}
export interface ProductWorkspaceSnapshot {
  ownerUserId: number;
  localProductId: string;
  viewRevision: number;
  product: ProductDetail;
  execution: ProductExecutionView;
  readiness: ProductReadiness;
  agent?: AgentDisplaySnapshot;
  planning?: import('./contracts-planning.js').PlanningGenerationState;
}
