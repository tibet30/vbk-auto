import type {
  AgentApprovalScope,
  AgentArtifactPreview,
  AgentCapabilities,
  AgentExternalToolsSnapshot,
  AgentMcpServerInput,
  AgentThreadWorkspace,
} from "./contracts-agent-runtime.js";

export type AgentThreadStatus =
  | "draft"
  | "running"
  | "waiting"
  | "needs_attention"
  | "completed"
  | "archived";

export type AgentThreadMessageRole = "user" | "assistant" | "system";

export interface AgentThreadSummary {
  revision: number;
  coveredMessageCount: number;
  text: string;
  updatedAt: string;
}

export interface AgentThread {
  id: string;
  ownerUserId: number;
  title: string;
  status: AgentThreadStatus;
  pinned: boolean;
  workingDirectory?: string;
  linkedProductId?: string;
  /** 本任务启用的 Skill id；缺省表示全部启用。 */
  enabledSkills?: string[];
  summary?: AgentThreadSummary;
  unread: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentThreadMessage {
  id: string;
  threadId: string;
  role: AgentThreadMessageRole;
  content: string;
  createdAt: string;
}

export interface AgentThreadDetail {
  thread: AgentThread;
  messages: AgentThreadMessage[];
}

export interface CreateAgentThreadInput {
  title?: string;
  prompt?: string;
  workingDirectory?: string;
  linkedProductId?: string;
}

export interface UpdateAgentThreadInput {
  title?: string;
  pinned?: boolean;
  workingDirectory?: string | null;
  /** 传数组表示只启用这些 Skill；传 null 表示恢复全部启用。 */
  enabledSkills?: string[] | null;
  status?: Extract<AgentThreadStatus, "draft" | "completed" | "archived">;
}

export interface AgentThreadContext {
  messages: Array<{ role: AgentThreadMessageRole; content: string }>;
  summary?: AgentThreadSummary;
  compressedMessageCount: number;
  estimatedTokens: number;
}

export interface AgentWorkspaceApi {
  list(): Promise<AgentThread[]>;
  create(input?: CreateAgentThreadInput): Promise<AgentThread>;
  get(id: string): Promise<AgentThreadWorkspace>;
  update(id: string, patch: UpdateAgentThreadInput): Promise<AgentThread>;
  /** 删除任务及其对话、运行、工具调用、授权与收据；执行中的任务不允许删除。 */
  remove(id: string): Promise<void>;
  send(id: string, content: string): Promise<AgentThreadWorkspace>;
  selectDirectory(id: string): Promise<AgentThreadWorkspace>;
  /** 批准挂起的写动作；scope 决定一次授权还是本任务内持续授权。 */
  approve(threadId: string, toolCallId: string, scope: AgentApprovalScope): Promise<AgentThreadWorkspace>;
  reject(threadId: string, toolCallId: string, reason?: string): Promise<AgentThreadWorkspace>;
  /** 结果不确定的写入：回读核查后收敛为成功或失败，禁止直接重试。 */
  reconcile(threadId: string, toolCallId: string): Promise<AgentThreadWorkspace>;
  /** 打开收据登记的产物：open = 用默认程序打开，reveal = 在文件夹中显示。 */
  openArtifact(threadId: string, receiptId: string, mode: "open" | "reveal"): Promise<void>;
  /** 取目录型产物的应用内预览 HTML（样式已内联，不含脚本）。 */
  previewArtifact(threadId: string, receiptId: string): Promise<AgentArtifactPreview>;
  /** 从上次中断处继续运行（needs_attention 时可用）。 */
  resume(threadId: string): Promise<AgentThreadWorkspace>;
  cancel(threadId: string): Promise<AgentThreadWorkspace>;
  /** 当前安装的 Skill 与外部工具：首页据此决定哪些入口真的可用。 */
  capabilities(): Promise<AgentCapabilities>;
  /** 读取外部 MCP 工具配置与连接状态。 */
  externalTools(): Promise<AgentExternalToolsSnapshot>;
  /** 保存配置并立即重连。 */
  saveExternalTools(servers: AgentMcpServerInput[]): Promise<AgentExternalToolsSnapshot>;
  /** 重新连接（server 升级后用于比对 Schema 变化）。 */
  refreshExternalTools(): Promise<AgentExternalToolsSnapshot>;
  /** 断开或重连单个外部服务；断开后它的工具不再暴露给模型。 */
  setExternalToolConnection(serverId: string, connected: boolean): Promise<AgentExternalToolsSnapshot>;
}

