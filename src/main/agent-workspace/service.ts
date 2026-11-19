import type {
  AgentThread,
  AgentThreadDetail,
  AgentThreadStatus,
  CreateAgentThreadInput,
  UpdateAgentThreadInput,
} from "../../shared/contracts-agent-workspace.js";
import type {
  AgentApprovalScope,
  AgentArtifactPreview,
  AgentCapabilities,
  AgentExternalToolsSnapshot,
  AgentMcpServerInput,
  AgentRun,
  AgentThreadWorkspace,
} from "../../shared/contracts-agent-runtime.js";
import type { MainIpcContext } from "../ipc/context.js";
import type { AgentModelMessage } from "../agent/types.js";
import fs from "node:fs";
import { assembleThreadContext, buildThreadSummary } from "./context-compression.js";
import { buildAccountReadPort, buildProductReadPort } from "./ports.js";
import { buildVbkReadPortFromContext } from "./vbk-adapter.js";
import { buildVbkWritePortFromContext } from "./vbk-write-adapter.js";
import { buildTibetReadPortFromContext } from "./tibet-adapter.js";
import { ExternalToolRuntime } from "./external-tools.js";
import { ExternalToolSettings } from "./external-tools-settings.js";
import { createModelProvider } from "./model-context.js";
import {
  buildArtifactPreview,
  createAgentRuntime,
  registryForScope,
  resolveArtifactForOpen,
  type AgentSkillRegistry,
  type AgentRuntime,
  type ResolvedArtifact,
} from "../agent-runtime/index.js";


function automaticTitle(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine || "新任务";
}

function threadStatusFor(run: AgentRun | undefined): AgentThreadStatus {  if (!run) return "waiting";
  if (run.status === "running" || run.status === "queued") return "running";
  if (run.status === "waiting_approval") return "waiting";
  if (run.status === "needs_attention" || run.status === "uncertain") return "needs_attention";
  return "waiting";
}

export class AgentWorkspaceService {
  private readonly running = new Set<string>();
  private readonly externalToolRuntime: ExternalToolRuntime;
  /** 设置页入口：与对话链路共用同一批 MCP 连接。 */
  readonly externalTools: ExternalToolSettings;
  private runtime: AgentRuntime;

  constructor(private readonly context: MainIpcContext) {
    this.externalToolRuntime = new ExternalToolRuntime(context.db);
    this.externalTools = new ExternalToolSettings(this.externalToolRuntime, () => {
      this.runtime = this.buildRuntime();
    });
    this.runtime = this.buildRuntime();
  }

  /** 只读端口只投影本机事实；外部 MCP Skill 也在这里装配，仍走同一套审批与收据。 */
  private buildRuntime(): AgentRuntime {
    return createAgentRuntime(this.context.db, {
      products: buildProductReadPort(this.context),
      accounts: buildAccountReadPort(this.context),
      vbk: buildVbkReadPortFromContext(this.context),
      vbkWrite: buildVbkWritePortFromContext(this.context),
      tibet: buildTibetReadPortFromContext(this.context),
      extraSkills: this.externalToolRuntime.currentSkills(),
    });
  }

  /** 每次开跑前刷新外部工具配置；失败只体现在面板诊断里，不阻断内置能力。 */
  /** 任务级 Skill 作用域：未设置时复用全量注册表。 */
  private registryFor(thread: { enabledSkills?: string[] }): AgentSkillRegistry {
    return registryForScope(this.runtime.registry, thread.enabledSkills);
  }

  private async reloadExternalTools(): Promise<void> {
    await this.externalToolRuntime.refresh();
    this.runtime = this.buildRuntime();
  }

  private owner(): number {
    const id = this.context.getExtensionUserId();
    if (!Number.isInteger(id) || id == null || id <= 0) throw new Error("请先登录应用账号。");
    return id;
  }

  /** 应用启动后调用一次：把中断的运行与动作收敛到可解释状态。 */
  recover(): { runs: number; toolCalls: number } {
    return this.runtime.runs.recoverInterrupted();
  }

  list() {
    return this.context.db.listAgentThreads(this.owner());
  }

  create(input: CreateAgentThreadInput = {}) {
    return this.context.db.createAgentThread(this.owner(), input);
  }

  get(id: string): AgentThreadWorkspace {
    const owner = this.owner();
    const detail = this.context.db.getAgentThreadDetail(owner, id);
    return this.compose(detail);
  }

  update(id: string, patch: UpdateAgentThreadInput): AgentThread {
    const owner = this.owner();
    const current = this.context.db.getAgentThread(owner, id);
    if (current && patch.workingDirectory !== undefined
      && patch.workingDirectory !== current.workingDirectory) {
      // 目录一变，旧目录上的授权立即失效。
      this.context.db.revokeAgentPermissionGrants(owner, id, "working_directory_changed");
    }
    if (patch.status === "archived") {
      this.context.db.revokeAgentPermissionGrants(owner, id, "thread_archived");
    }
    return this.context.db.updateAgentThread(owner, id, patch);
  }

  async send(id: string, content: string): Promise<AgentThreadWorkspace> {
    const owner = this.owner();
    const prompt = content.trim();
    if (!prompt) throw new Error("请输入任务内容。");
    if (this.running.has(id)) throw new Error("当前任务仍在处理中，请稍候。");
    const current = this.context.db.getAgentThread(owner, id);
    if (!current) throw new Error(`智能体任务不存在：${id}`);
    if (current.status === "archived") throw new Error("已归档任务不能继续执行，请先恢复任务。");
    const active = this.context.db.findActiveAgentRun(owner, id);
    if (active?.status === "waiting_approval") throw new Error("当前任务有待审批动作，请先批准或拒绝。");

    this.running.add(id);
    this.context.db.addAgentThreadMessage(owner, id, "user", prompt);
    this.context.memoryService?.captureExplicitFromUserMessage(prompt, {
      sourceKind: "agent-workspace:user",
      taskId: id,
    });
    this.context.db.updateAgentThread(owner, id, {
      ...(current.title === "新任务" ? { title: automaticTitle(prompt) } : {}),
      runtimeStatus: "running",
    });
    try {
      await this.reloadExternalTools();
      const before = this.context.db.getAgentThreadDetail(owner, id);
      const sum = buildThreadSummary(before.messages, before.thread.summary);
      if (sum) this.context.db.updateAgentThread(owner, id, { summary: sum });
      const history = this.history(before, sum);
      const run = await this.runtime.runs.start({
        ownerUserId: owner,
        threadId: id,
        intent: prompt,
        registry: this.registryFor(current),
        history,
        ...(current.workingDirectory ? { workingDirectory: current.workingDirectory } : {}),
        provider: () => createModelProvider({ context: this.context, summary: sum, skills: this.runtime.registry.summaries() }),
      });
      this.context.db.updateAgentThread(owner, id, { runtimeStatus: threadStatusFor(run) });
      return this.get(id);
    } catch (error) {
      this.context.db.updateAgentThread(owner, id, { runtimeStatus: "needs_attention" });
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  async approve(threadId: string, toolCallId: string, scope: AgentApprovalScope): Promise<AgentThreadWorkspace> {
    return this.advancePending(threadId, toolCallId, "approve", { scope });
  }

  async reject(threadId: string, toolCallId: string, reason?: string): Promise<AgentThreadWorkspace> {
    return this.advancePending(threadId, toolCallId, "reject", { reason });
  }

  /** 不确定写入的核查入口：只读回读，收敛后任务回到"需要处理，可继续"。 */
  async reconcile(threadId: string, toolCallId: string): Promise<AgentThreadWorkspace> {
    const owner = this.owner();
    const thread = this.context.db.getAgentThread(owner, threadId);
    if (!thread) throw new Error(`智能体任务不存在：${threadId}`);
    await this.runtime.runs.reconcile({
      ownerUserId: owner,
      threadId,
      toolCallId,
      ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
    });
    this.context.db.updateAgentThread(owner, threadId, { runtimeStatus: "needs_attention" });
    return this.get(threadId);
  }

  /** 从中断处继续当前运行（只在 needs_attention 时可用）。 */
  async resume(threadId: string): Promise<AgentThreadWorkspace> {
    const owner = this.owner();
    if (this.running.has(threadId)) throw new Error("当前任务仍在处理中，请稍候。");
    const thread = this.context.db.getAgentThread(owner, threadId);
    if (!thread) throw new Error(`智能体任务不存在：${threadId}`);
    this.running.add(threadId);
    try {
      await this.reloadExternalTools();
      const before = this.context.db.getAgentThreadDetail(owner, threadId);
      const run = await this.runtime.runs.resume({
        ownerUserId: owner,
        threadId,
        registry: this.registryFor(thread),
        history: this.history(before, before.thread.summary),
        ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
        provider: () => createModelProvider({ context: this.context, summary: before.thread.summary, skills: this.runtime.registry.summaries() }),
      });
      this.context.db.updateAgentThread(owner, threadId, { runtimeStatus: threadStatusFor(run) });
      return this.get(threadId);
    } catch (error) {
      this.context.db.updateAgentThread(owner, threadId, { runtimeStatus: "needs_attention" });
      throw error;
    } finally {
      this.running.delete(threadId);
    }
  }

  /** 校验并解析收据登记的产物；真正的系统打开动作留在 IPC 层。 */
  async resolveArtifact(threadId: string, receiptId: string): Promise<ResolvedArtifact> {
    const owner = this.owner();
    const thread = this.context.db.getAgentThread(owner, threadId);
    if (!thread) throw new Error(`智能体任务不存在：${threadId}`);
    return resolveArtifactForOpen({
      db: this.context.db,
      ownerUserId: owner,
      threadId,
      receiptId,
      ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
    });
  }

  /** 应用内预览：只支持目录型产物（网页工程），样式在主进程内联后返回。 */
  async previewArtifact(threadId: string, receiptId: string): Promise<AgentArtifactPreview> {
    const owner = this.owner();
    const thread = this.context.db.getAgentThread(owner, threadId);
    if (!thread) throw new Error(`智能体任务不存在：${threadId}`);
    return buildArtifactPreview({
      db: this.context.db,
      ownerUserId: owner,
      threadId,
      receiptId,
      ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
    });
  }

  /** 当前能力：只读注册表与外部工具状态，不触发模型调用。 */
  async capabilities(): Promise<AgentCapabilities> {
    await this.externalToolRuntime.refresh();
    return {
      skills: this.runtime.registry.summaries(),
      externalTools: this.externalToolRuntime.currentStatus(),
    };
  }

  async cancel(threadId: string): Promise<AgentThreadWorkspace> {
    const owner = this.owner();
    if (this.running.has(threadId)) throw new Error("当前任务仍在处理中，请稍候。");
    const run = await this.runtime.runs.cancel({ ownerUserId: owner, threadId });
    this.context.db.updateAgentThread(owner, threadId, { runtimeStatus: threadStatusFor(run) });
    return this.get(threadId);
  }

  private async advancePending(
    threadId: string,
    toolCallId: string,
    mode: "approve" | "reject",
    extra: { scope?: AgentApprovalScope; reason?: string },
  ): Promise<AgentThreadWorkspace> {
    const owner = this.owner();
    if (this.running.has(threadId)) throw new Error("当前任务仍在处理中，请稍候。");
    const thread = this.context.db.getAgentThread(owner, threadId);
    if (!thread) throw new Error(`智能体任务不存在：${threadId}`);
    this.running.add(threadId);
    try {
      const before = this.context.db.getAgentThreadDetail(owner, threadId);
      const run = mode === "approve"
        ? await this.runtime.runs.approve({
          ownerUserId: owner,
          threadId,
          toolCallId,
          registry: this.registryFor(thread),
          scope: extra.scope ?? "once",
          history: this.history(before, before.thread.summary),
          ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
          provider: () => createModelProvider({ context: this.context, summary: before.thread.summary, skills: this.runtime.registry.summaries() }),
        })
        : await this.runtime.runs.reject({
          ownerUserId: owner,
          threadId,
          toolCallId,
          ...(extra.reason ? { reason: extra.reason } : {}),
          ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
        });
      const summary = buildThreadSummary(before.messages, before.thread.summary);
      this.context.db.updateAgentThread(owner, threadId, {
        runtimeStatus: threadStatusFor(run),
        ...(summary ? { summary } : {}),
      });
      return this.get(threadId);
    } catch (error) {
      this.context.db.updateAgentThread(owner, threadId, { runtimeStatus: "needs_attention" });
      throw error;
    } finally {
      this.running.delete(threadId);
    }
  }

  private compose(detail: AgentThreadDetail): AgentThreadWorkspace {
    const owner = this.owner();
    const runtime = this.runtime.runs.snapshot({
      ownerUserId: owner,
      threadId: detail.thread.id,
      ...(detail.thread.enabledSkills !== undefined ? { enabledSkills: detail.thread.enabledSkills } : {}),
      ...(detail.thread.workingDirectory ? { workingDirectory: detail.thread.workingDirectory } : {}),
    });
    const externalTools = this.externalToolRuntime.currentStatus();
    const composed = { ...detail, runtime: externalTools.length ? { ...runtime, externalTools } : runtime };
    const available = workingDirectoryAvailable(detail.thread.workingDirectory);
    return available === undefined ? composed : { ...composed, workingDirectoryAvailable: available };
  }

  private history(
    detail: AgentThreadDetail,
    summary: AgentThreadDetail["thread"]["summary"],
  ): AgentModelMessage[] {
    const assembled = assembleThreadContext({ messages: detail.messages, summary });
    return assembled.messages.map((message) => ({ role: message.role, content: message.content }));
  }
}

/** 任务目录是否可用：不存在或不是目录时，界面要能提前提示，而不是等模型跑起来才报错。 */
function workingDirectoryAvailable(directory: string | undefined): boolean | undefined {
  if (!directory) return undefined;
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

