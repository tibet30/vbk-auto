import type { AgentApproval, AgentEvent, AgentInputRequest, AgentSnapshot } from "../../shared/contracts.js";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Preserve provider text so malformed JSON can be returned as feedback instead of guessed as `{}`. */
  rawArguments?: string;
  argumentError?: string;
}
export interface AgentModelMessage { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: AgentToolCall[]; }
export interface AgentModelResult { content?: string; toolCalls?: AgentToolCall[]; usage?: { inputTokens?: number; outputTokens?: number; }; }
export interface AgentModelInput {
  messages: AgentModelMessage[];
  tools: AgentToolDefinition[];
  /** Cumulative public answer text. An empty value resets a failed/retried attempt. */
  onContent?(content: string): void | Promise<void>;
}
export interface AgentModel {
  complete(input: AgentModelInput): Promise<AgentModelResult>;
}
export interface AgentToolDefinition { name: string; description: string; parameters: Record<string, unknown>; write?: boolean; }
export interface AgentToolContext {
  localProductId: string;
  accountKey: string;
  productVersion: string;
  approval?: AgentApproval;
}
export interface AgentToolResult { content: string; data?: Record<string, unknown>; uncertainWrite?: boolean; }
/** Tool adapters throw this when a write may have reached the remote system but no readback is available. */
export class AgentUncertainWriteError extends Error {
  readonly uncertainWrite = true;
  constructor(message = "写入结果不确定") { super(message); this.name = "AgentUncertainWriteError"; }
}
export interface AgentTool extends AgentToolDefinition {
  /** Exact scope required by this invocation; phase writers should derive scope from args. */
  approvalScope?: string[] | ((args: Record<string, unknown>) => string[]);
  requiresApproval?: boolean;
  validate?(args: Record<string, unknown>): string | undefined;
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
}
export interface AgentFinishContext {
  runId: string;
  hadWrites: boolean;
  hadRemoteWrites: boolean;
  /** Post-approval deterministic runner finished; durable automation is evidence. */
  deterministicWorkflow?: boolean;
}
export interface AgentFinishResult {
  verified: boolean;
  message?: string;
  /** Optional final write approval prepared by the business readiness gate. */
  finalApproval?: { scope: string[]; summary: string };
}
export interface AgentSnapshotStore {
  getAgentSnapshot(id: string): AgentSnapshot | undefined;
  saveAgentSnapshot(snapshot: AgentSnapshot): void;
}
export interface AgentCoreDependencies {
  model?: AgentModel;
  modelFor?(localProductId: string): Promise<AgentModel>;
  tools: AgentTool[];
  accountFor(localProductId: string): Promise<{ accountKey: string; productVersion: string }>;
  productFingerprint?(localProductId: string): Promise<string>;
  /** Applies deterministic local repairs implied by an explicit new user
   * instruction before the next intent fingerprint and model turn are made. */
  prepareUserInstruction?(localProductId: string, content: string): Promise<void> | void;
  recoverApproval?(localProductId: string, snapshot: AgentSnapshot): Promise<AgentApproval | undefined>;
  /** Starts the deterministic, already-authorised VBK workflow. Returns true
   * only when Agent must yield instead of asking the model for another step. */
  handoffApprovedWorkflow?(localProductId: string, approval: AgentApproval): boolean;
  contextFor?(localProductId: string): Promise<string>;
  finishVerified?(localProductId: string, context?: AgentFinishContext): Promise<AgentFinishResult>;
  reconcileUncertainWrite?(localProductId: string, uncertain: { toolCallId: string; message: string }): Promise<{ reconciled: boolean; retryable?: boolean; message?: string }>;
  approvalPrecondition?(localProductId: string, scope: string[]): Promise<string | undefined>;
  normalizeApprovalScope?(localProductId: string, scope: string[]): string[] | Promise<string[]>;
  now?: () => Date;
  id?: () => string;
}
export interface AgentNativeInputArgs { questions: AgentInputRequest["questions"]; }
export interface AgentNativeApprovalArgs { scope: string[]; summary: string; }
export type StoredAgentEvent = AgentEvent;
