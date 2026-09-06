export type AgentRunStatus = "queued" | "running" | "waiting_input" | "waiting_approval" | "paused" | "completed" | "failed" | "abandoned";
export type AgentEventType = "user" | "assistant" | "tool_call" | "tool_result" | "status" | "input_request" | "approval_request" | "approval";

export interface AgentQuestionOption { id: string; label: string; }
export interface AgentQuestion {
  id: string;
  label: string;
  kind: "text" | "single" | "multiple" | "confirm";
  required: boolean;
  options?: AgentQuestionOption[];
  placeholder?: string;
}
export interface AgentInputRequest {
  id: string;
  questions: AgentQuestion[];
  createdAt: string;
  /** 系统已按默认业务规则自动采纳、无需展示给用户选择的回答。 */
  defaultAnswers?: Record<string, string | string[]>;
}
export interface AgentApproval {
  id: string;
  productVersion: string;
  accountKey: string;
  scope: string[];
  summary: string;
  status: "pending" | "approved" | "invalidated";
  createdAt: string;
  intentVersion?: string;
}
export interface AgentRun {
  id: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  intentVersion?: string;
}
export interface AgentEvent {
  id: string;
  runId: string;
  type: AgentEventType;
  createdAt: string;
  content: string;
  data?: Record<string, unknown>;
}
export interface AgentSnapshot {
  localProductId: string;
  /** Monotonic local revision timestamp for IPC clients to reject stale poll results. */
  updatedAt?: string;
  run: AgentRun | null;
  events: AgentEvent[];
  pendingInput?: AgentInputRequest;
  pendingApproval?: AgentApproval;
  uncertainWrite?: { toolCallId: string; message: string; createdAt: string };
}
export interface AgentInputResponse { requestId: string; answers: Record<string, string | string[]>; }
export interface AgentApprovalResponse { approvalId: string; productVersion: string; }
export interface AgentIllegalKeywordRepairInput {
  content: string;
  keywords: string[];
  affectedPaths: string[];
}
