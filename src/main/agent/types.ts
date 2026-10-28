import type {
  AgentApproval,
  AgentEvent,
  AgentInputRequest,
  AgentSnapshot,
  ProductDetail,
} from "../../shared/contracts.js";
import type { WizardStageRetryPhase } from "../../shared/wizard-stage-retry.js";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Preserve provider text so malformed JSON can be returned as feedback instead of guessed as `{}`. */
  rawArguments?: string;
  argumentError?: string;
}
export interface AgentModelMessage { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: AgentToolCall[]; }
export interface AgentModelResult { content?: string; toolCalls?: AgentToolCall[]; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; }; }
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
export interface AgentToolResult {
  content: string;
  data?: Record<string, unknown>;
  uncertainWrite?: boolean;
  /** The tool completed the whole Agent run with its own authoritative evidence. */
  terminal?: boolean;
}
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
  /** A persisted, non-repairable local prerequisite should stop the model loop. */
  pauseReason?: string;
  /** Optional final write approval prepared by the business readiness gate. */
  finalApproval?: { scope: string[]; summary: string };
}
export interface AgentSnapshotStore {
  getAgentSnapshot(id: string): AgentSnapshot | undefined;
  saveAgentSnapshot(snapshot: AgentSnapshot): void;
}
export interface AgentCoreDependencies {
  /** Explicit development safe startup blocks only account-bound external actions. */
  externalAgentActionsEnabled?: boolean;
  /** Lets safe-startup recovery state a completed local-preparation fact truthfully. */
  safeStartupLocalPreparationReady?(localProductId: string): boolean;
  model?: AgentModel;
  modelFor?(localProductId: string): Promise<AgentModel>;
  tools: AgentTool[];
  accountFor(localProductId: string): Promise<{ accountKey: string; productVersion: string }>;
  productFingerprint?(localProductId: string): Promise<string>;
  prepareWorkflowReplay?(localProductId: string, content: string): Promise<{
    scope: string[]; summary: string; automationRunId: string; automationRunStatus?: "failed" | "succeeded";
  } | undefined> | { scope: string[]; summary: string; automationRunId: string; automationRunStatus?: "failed" | "succeeded" } | undefined;
  /**
   * Read-only preparation for an explicit VBK wizard-stage retry. The adapter
   * must derive this from the saved product and current remote menu state; it
   * does not perform the “下一步” write itself.
   */
  prepareWizardStageRetry?(localProductId: string, phase: WizardStageRetryPhase): Promise<{
    scope: string[];
    summary: string;
    phase: WizardStageRetryPhase;
    alreadyAdvanced: boolean;
  } | undefined> | {
    scope: string[];
    summary: string;
    phase: WizardStageRetryPhase;
    alreadyAdvanced: boolean;
  } | undefined;
  /** Applies deterministic local repairs implied by an explicit new user
   * instruction before the next intent fingerprint and model turn are made. */
  prepareUserInstruction?(localProductId: string, content: string, selection?: {
    selectedLabels: string[];
    selectedQuestions?: Array<{ id: string; label: string; selectedLabel: string }>;
  }): Promise<boolean | void> | boolean | void;
  /** Resolve only questions whose requested data is proved by the latest saved product. */
  resolvedPendingQuestions?(localProductId: string, questions: AgentInputRequest["questions"]): Array<{
    id: string; message: string; answer?: string; pause?: boolean;
  }>;
  recoverApproval?(localProductId: string, snapshot: AgentSnapshot): Promise<AgentApproval | undefined>;
  /** Starts the deterministic, already-authorised VBK workflow. Returns true
   * only when Agent must yield instead of asking the model for another step. */
  handoffApprovedWorkflow?(localProductId: string, approval: AgentApproval): boolean;
  contextFor?(localProductId: string): Promise<string>;
  finishVerified?(localProductId: string, context?: AgentFinishContext): Promise<AgentFinishResult>;
  /** Whether a historical no-write completion still needs the business readiness gate. */
  requiresCompletionVerification?(localProductId: string, snapshot: AgentSnapshot): boolean;
  /** Current persisted product for bounded deterministic preparation steps. */
  preparationProduct?(localProductId: string): ProductDetail | undefined;
  reconcileUncertainWrite?(localProductId: string, uncertain: { toolCallId: string; message: string }): Promise<{ reconciled: boolean; retryable?: boolean; message?: string }>;
  approvalPrecondition?(
    localProductId: string,
    scope: string[],
    options?: { wizardStageRetry?: WizardStageRetryPhase },
  ): Promise<string | undefined>;
  normalizeApprovalScope?(localProductId: string, scope: string[]): string[] | Promise<string[]>;
  /** 所有确认卡创建前的说明补全（如改天数转新建提示）；须幂等。 */
  completeApprovalSummary?(localProductId: string, scope: string[], summary: string): string;
  now?: () => Date;
  id?: () => string;
}
export interface AgentNativeInputArgs { questions: AgentInputRequest["questions"]; }
export interface AgentNativeApprovalArgs { scope: string[]; summary: string; }
export type StoredAgentEvent = AgentEvent;
