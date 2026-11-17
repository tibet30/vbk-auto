/**
 * 通用智能体运行事实契约。
 *
 * 分层不变量：`AgentThread` 保存用户意图，`AgentRun` 保存一次执行，
 * `AgentActionReceipt` 保存外部世界实际发生的结果。模型输出不是事实来源，
 * 未经收据证明的写入一律不得对外声称已完成。
 */
import type { AgentThreadDetail } from "./contracts-agent-workspace.js";

/** 运行状态机：queued → running → waiting_approval → running → completed；
 * 另有 rejected / cancelled / uncertain / needs_attention / failed 分支。 */
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "needs_attention"
  | "cancelled"
  | "rejected"
  | "uncertain"
  | "completed"
  | "failed";

/** 动作类别决定授权策略：读取静默执行，写入与删除必须经授权。 */
export type AgentActionKind = "read" | "write" | "delete";

export type AgentActionRisk = "low" | "medium" | "high";

export type AgentToolCallStatus =
  | "awaiting_approval"
  | "denied"
  | "executing"
  | "succeeded"
  | "failed"
  | "uncertain";

export type AgentReceiptStatus = "succeeded" | "failed" | "uncertain";

/** once = 只批准这次调用；thread = 本次任务内同类动作在目录范围内持续有效。 */
export type AgentApprovalScope = "once" | "thread";

export interface AgentSkillActionSummary {
  name: string;
  label: string;
  kind: AgentActionKind;
}

export interface AgentSkillSummary {
  id: string;
  label: string;
  description: string;
  actions: AgentSkillActionSummary[];
}

export interface AgentRun {
  id: string;
  threadId: string;
  ownerUserId: number;
  status: AgentRunStatus;
  intent: string;
  step: number;
  maxSteps: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentToolCallRecord {
  id: string;
  runId: string;
  threadId: string;
  skillId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: AgentToolCallStatus;
  kind: AgentActionKind;
  risk: AgentActionRisk;
  idempotencyKey: string;
  accountKey?: string;
  targetKey?: string;
  summary: string;
  diff?: string;
  error?: string;
  receiptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPermissionGrant {
  id: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  scope: AgentApprovalScope;
  action: string;
  targetKey: string;
  accountKey: string;
  grantedAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

/** 产物：收据证明"磁盘上真的有了什么"，面板据此展示文件树与预览入口。 */
export interface AgentArtifactFile {
  /** 相对产物根（文件型产物为空串）。 */
  path: string;
  bytes: number;
}

export interface AgentArtifact {
  kind: "file" | "directory";
  /** 产物根的绝对路径；打开时仍会按任务授权目录重新校验。 */
  path: string;
  files: AgentArtifactFile[];
  /** 预览入口（相对产物根），例如网页的 index.html。 */
  entry?: string;
}

export interface AgentActionReceipt {
  id: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  action: string;
  targetKey: string;
  accountKey: string;
  idempotencyKey: string;
  status: AgentReceiptStatus;
  before?: string;
  result: string;
  detail?: string;
  artifact?: AgentArtifact;
  createdAt: string;
}

/** 应用内预览：已内联样式的 HTML，渲染层用 sandbox iframe 承载。 */
export interface AgentArtifactPreview {
  html: string;
  entry: string;
  truncated: boolean;
}

/** 审批卡所需的全部事实：Skill、动作、目标、账号/目录、预计影响与授权范围。 */
export interface AgentApprovalRequest {
  toolCallId: string;
  runId: string;
  skillId: string;
  skillLabel: string;
  toolName: string;
  actionLabel: string;
  kind: AgentActionKind;
  risk: AgentActionRisk;
  accountKey: string;
  directory?: string;
  targetKey: string;
  summary: string;
  diff?: string;
  scopes: AgentApprovalScope[];
}

/** 写队列状态：同一账号的写操作串行，这里让"谁在写、谁在排队"可见。 */
export interface AgentWriteQueueState {
  accountKey: string;
  /** 是否已有写操作在执行。 */
  running: boolean;
  /** 正在等待执行的写操作数量。 */
  waiting: number;
  /** 当前执行开始时间（running 时才有）。 */
  since?: string;
  /** 当前持锁的任务 id（可能是另一个任务）。 */
  holderThreadId?: string;
}

/** 外部 MCP 工具的连接诊断：面板只展示，不提供改配置入口。 */
export interface AgentExternalToolStatus {
  serverId: string;
  label: string;
  state: "idle" | "connecting" | "ready" | "failed" | "closed";
  tools: string[];
  /** server 升级导致的工具 Schema 变化。 */
  changes: string[];
  error?: string;
}

/** 设置页可编辑的 MCP 服务配置（env 不在此列：避免把长期凭据写进设置表）。 */
export interface AgentMcpServerInput {
  id: string;
  label?: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface AgentExternalToolsSnapshot {
  servers: AgentMcpServerInput[];
  status: AgentExternalToolStatus[];
  /** 配置里被跳过的条目原因。 */
  skipped: string[];
}

/** 右侧工作面板只由运行事实驱动，不允许由界面自己发明状态。 */
export interface AgentRuntimeSnapshot {
  run?: AgentRun;
  approval?: AgentApprovalRequest;
  toolCalls: AgentToolCallRecord[];
  receipts: AgentActionReceipt[];
  skills: AgentSkillSummary[];
  /** 已配置的外部 MCP 服务状态；未配置时为空。 */
  externalTools?: AgentExternalToolStatus[];
  /** 本任务启用的 Skill id；缺省表示全部启用（`skills` 始终是全部已装清单）。 */
  enabledSkills?: string[];
  /** 非空的写队列；空数组与缺省都表示当前没有写入竞争。 */
  writeQueues?: AgentWriteQueueState[];
  /** 最近若干次运行（倒序）；多轮任务据此回看历史。 */
  runs?: AgentRun[];
}

/** 当前安装能力：首页据此区分"真的能做"与"未接入"。 */
export interface AgentCapabilities {
  skills: AgentSkillSummary[];
  externalTools: AgentExternalToolStatus[];
}

export interface AgentThreadWorkspace extends AgentThreadDetail {
  runtime: AgentRuntimeSnapshot;
  /** 已选工作目录是否真实存在且是目录；未选目录时为 undefined。 */
  workingDirectoryAvailable?: boolean;
}
