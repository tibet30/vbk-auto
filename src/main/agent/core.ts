import type {
  AgentApprovalResponse, AgentEvent, AgentEventType,
  AgentIllegalKeywordRepairInput, AgentInputResponse, AgentRun, AgentRunStatus, AgentSnapshot,
} from "../../shared/contracts.js";
import { completeWithRetries } from "./core-model.js";
import { AgentSnapshotManager, type AgentStreamState, type NoProgressBlocker, type TurnToken } from "./core-snapshot.js";
import { AgentToolRunner } from "./core-tools.js";
import { buildModelMessages } from "./core-transcript.js";
import { cleanList, nativeToolSchemas, validateAnswers } from "./core-validation.js";
import type { AgentCoreDependencies, AgentModelMessage, AgentToolCall } from "./types.js";

export interface AgentSnapshotStore {
  getAgentSnapshot(id: string): AgentSnapshot | undefined;
  saveAgentSnapshot(snapshot: AgentSnapshot): void;
}

export class AgentCore {
  private readonly active = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly snapshots: AgentSnapshotManager;
  private readonly toolRunner: AgentToolRunner;

  constructor(private readonly deps: AgentCoreDependencies, store: AgentSnapshotStore) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => crypto.randomUUID());
    this.snapshots = new AgentSnapshotManager(store, this.now, this.id);
    this.toolRunner = new AgentToolRunner(deps, this.snapshots, this.now, this.id);
  }

  async get(id: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const snapshot = this.load(id);
      const detached = !this.active.has(id) && !this.scheduled.has(id);
      if (detached) this.snapshots.recoverInterruptedCalls(snapshot);
      if (detached) this.snapshots.interruptStreaming(snapshot, "应用中断，回复未完成。");
      if (snapshot.run?.status === "running" && detached) {
        this.pauseRun(snapshot, "应用重启后已在安全检查点暂停。");
      }
      return this.save(snapshot);
    });
  }

  async send(id: string, content: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const text = content.trim();
      if (!text) return this.load(id);
      const intentVersion = await this.intent(id);
      let snapshot = this.load(id);
      if (!this.active.has(id) && !this.scheduled.has(id)) this.snapshots.recoverInterruptedCalls(snapshot);
      this.snapshots.interruptStreaming(snapshot, "已由新的要求中止。");
      this.cancelPendingInteraction(snapshot, "新请求已替代此前等待中的交互。");
      if (!snapshot.run || this.terminal(snapshot.run.status)) {
        snapshot = { ...snapshot, run: this.run("queued"), pendingInput: undefined, pendingApproval: undefined };
      }
      snapshot.run!.intentVersion = intentVersion;
      snapshot.run!.error = undefined;
      this.event(snapshot, "user", text);
      if (snapshot.uncertainWrite) this.pauseRun(snapshot, "写入结果尚未权威核对；已保存新要求，核对后才能继续。");
      else this.running(snapshot);
      const saved = this.save(snapshot);
      if (saved.run?.status === "running") this.schedule(id);
      return saved;
    });
  }

  async repairIllegalKeywords(id: string, input: AgentIllegalKeywordRepairInput): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const text = input.content.trim();
      if (!text) return this.load(id);
      const intentVersion = await this.intent(id);
      let snapshot = this.load(id);
      if (!this.active.has(id) && !this.scheduled.has(id)) this.snapshots.recoverInterruptedCalls(snapshot);
      this.snapshots.interruptStreaming(snapshot, "已由非法关键词修复任务接管。");
      this.cancelPendingInteraction(snapshot, "非法关键词修复任务已替代此前等待中的交互。");
      if (!snapshot.run || this.terminal(snapshot.run.status)) {
        snapshot = { ...snapshot, run: this.run("queued"), pendingInput: undefined, pendingApproval: undefined };
      }
      snapshot.run!.intentVersion = intentVersion;
      snapshot.run!.error = undefined;
      this.event(snapshot, "user", text, {
        illegalKeywordRepair: true,
        keywords: input.keywords,
        affectedPaths: input.affectedPaths,
      });
      this.event(snapshot, "status", `已记录 VBK 文案黑名单：${input.keywords.join("、") || "见错误详情"}，开始重写图文。`, {
        illegalKeywordRepair: true,
        keywords: input.keywords,
        affectedPaths: input.affectedPaths,
      });
      snapshot.uncertainWrite = undefined;
      this.running(snapshot);
      const saved = this.save(snapshot);
      this.schedule(id);
      return saved;
    });
  }

  async respond(id: string, response: AgentInputResponse): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const snapshot = this.load(id);
      const request = snapshot.pendingInput;
      if (!request || !["waiting_input", "paused"].includes(snapshot.run?.status ?? "")
        || request.id !== response.requestId || !validateAnswers(request, response.answers)) return snapshot;
      snapshot.pendingInput = undefined;
      const toolCallId = this.pendingCallId(snapshot, "input_request", request.id);
      const answers = { ...(request.defaultAnswers ?? {}), ...response.answers };
      if (toolCallId) this.result(snapshot, toolCallId, JSON.stringify(answers), { requestId: request.id });
      this.event(snapshot, "user", `用户回答：${JSON.stringify(answers)}`, { requestId: request.id, answers });
      this.running(snapshot);
      const saved = this.save(snapshot);
      this.schedule(id);
      return saved;
    });
  }

  async approve(id: string, response: AgentApprovalResponse): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const pending = this.load(id).pendingApproval;
      if (!pending || pending.id !== response.approvalId || pending.productVersion !== response.productVersion) return this.load(id);
      const precondition = await this.deps.approvalPrecondition?.(id, pending.scope);
      const identity = precondition ? undefined : await this.deps.accountFor(id);
      const snapshot = this.load(id);
      const approval = snapshot.pendingApproval;
      if (!approval || !["waiting_approval", "paused"].includes(snapshot.run?.status ?? "")
        || approval.id !== response.approvalId || approval.productVersion !== response.productVersion) return snapshot;
      const toolCallId = this.pendingCallId(snapshot, "approval_request", approval.id);
      if (precondition || !identity || approval.accountKey !== identity.accountKey || approval.productVersion !== identity.productVersion
        || approval.intentVersion !== snapshot.run?.intentVersion) {
        approval.status = "invalidated";
        snapshot.pendingApproval = undefined;
        this.event(snapshot, "approval", "授权已失效", { approval });
        const message = precondition ? `授权前置条件已变化：${precondition}` : "授权已失效，请重新申请。";
        const blocker: NoProgressBlocker = precondition ? "approval_precondition" : "authorization_denied";
        if (toolCallId) this.blockedResult(snapshot, toolCallId, message, blocker, { approvalId: approval.id });
        else this.completionBlocked(snapshot, message, blocker);
      } else {
        approval.status = "approved";
        snapshot.pendingApproval = undefined;
        this.event(snapshot, "approval", "用户已授权", { approval });
        if (toolCallId) this.result(snapshot, toolCallId, "授权已确认。", { approval });
      }
      if (snapshot.run?.status !== "paused") this.running(snapshot);
      const saved = this.save(snapshot);
      if (saved.run?.status === "running") this.schedule(id);
      return saved;
    });
  }

  async pause(id: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const snapshot = this.load(id);
      this.snapshots.interruptStreaming(snapshot, "已暂停，回复未完成。");
      if (snapshot.run && !this.terminal(snapshot.run.status)) this.pauseRun(snapshot, "运行已暂停");
      return this.save(snapshot);
    });
  }

  async resume(id: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      let snapshot = this.load(id);
      if (!this.active.has(id) && !this.scheduled.has(id)) this.snapshots.recoverInterruptedCalls(snapshot);
      if (!snapshot.run || ["completed", "abandoned"].includes(snapshot.run.status)) return snapshot;
      const openRetryWindow = snapshot.run.status === "paused";
      if (snapshot.pendingInput) { this.waiting(snapshot, "waiting_input"); return this.save(snapshot); }
      if (snapshot.pendingApproval) { this.waiting(snapshot, "waiting_approval"); return this.save(snapshot); }
      if (snapshot.uncertainWrite) {
        const uncertain = structuredClone(snapshot.uncertainWrite);
        const reconciliation = await this.deps.reconcileUncertainWrite?.(id, uncertain);
        snapshot = this.load(id);
        if (!snapshot.uncertainWrite || snapshot.uncertainWrite.toolCallId !== uncertain.toolCallId) return snapshot;
        if (!reconciliation?.reconciled && !reconciliation?.retryable) {
          this.pauseRun(snapshot, reconciliation?.message ?? "写入结果尚未权威核对，不能继续。");
          return this.save(snapshot);
        }
        if (reconciliation.retryable) {
          snapshot.uncertainWrite = undefined;
          this.event(snapshot, "status", reconciliation.message ?? "已确认上一轮未形成可验证写入，可定向重试。", { retryable: true });
        } else {
        const message = reconciliation.message ?? "不确定写入已核对。";
        this.snapshots.reconcileCall(snapshot, uncertain.toolCallId, message);
        snapshot.uncertainWrite = undefined;
        this.event(snapshot, "status", message, { reconciled: true });
        }
      }
      if (openRetryWindow) this.snapshots.openNoProgressRetryWindow(snapshot);
      snapshot.run!.error = undefined;
      this.running(snapshot);
      const saved = this.save(snapshot);
      this.schedule(id);
      return saved;
    });
  }

  async abandon(id: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const snapshot = this.load(id);
      if (snapshot.run && !this.terminal(snapshot.run.status)) {
        this.snapshots.interruptStreaming(snapshot, "任务已废弃，回复未完成。");
        this.cancelPendingInteraction(snapshot, "运行已放弃。");
        snapshot.run.status = "abandoned";
        this.touch(snapshot.run);
        this.event(snapshot, "status", "运行已放弃", { status: "abandoned" });
      }
      return this.save(snapshot);
    });
  }

  async idle(id: string): Promise<void> {
    while (this.active.has(id) || this.scheduled.has(id) || this.commandTails.has(id)) {
      await new Promise((done) => setTimeout(done, 1));
    }
  }

  private schedule(id: string): void {
    if (this.active.has(id) || this.scheduled.has(id)) return;
    this.scheduled.add(id);
    queueMicrotask(() => { this.scheduled.delete(id); void this.drive(id); });
  }

  private async drive(id: string): Promise<void> {
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      for (let round = 0; round < 80; round += 1) {
        const before = this.load(id);
        if (before.run?.status !== "running" || before.uncertainWrite) break;
        const token = this.token(before);
        const messages = await this.messages(before);
        if (!this.current(this.load(id), token)) continue;
        const model = await this.model(id);
        if (!this.current(this.load(id), token)) continue;

        const modelTurnId = this.id();
        const streamState: AgentStreamState = { lastSavedAt: 0 };
        let output;
        try {
          output = await completeWithRetries(model, { messages, tools: this.schemas(),
            onContent: (content) => this.snapshots.publishStreaming(id, token, modelTurnId, streamState, content) });
        } catch (error) {
          const failed = this.load(id);
          if (!this.current(failed, token)) continue;
          this.snapshots.interruptStreaming(failed, "生成中断，请重试。", modelTurnId);
          if (failed.run) {
            failed.run.status = "failed";
            failed.run.error = error instanceof Error ? error.message : String(error);
            this.touch(failed.run);
            this.event(failed, "status", failed.run.error, { status: "failed" });
          }
          this.save(failed);
          break;
        }

        const current = this.load(id);
        if (!this.current(current, token)) continue;
        const calls = output.toolCalls ?? [];
        const streamedEvent = current.events.find((event) => event.id === streamState.eventId);
        if (streamedEvent && output.content) {
          streamedEvent.content = output.content;
          streamedEvent.data = { ...streamedEvent.data, streaming: false };
        } else if (streamedEvent) {
          current.events = current.events.filter((event) => event.id !== streamedEvent.id);
        }
        if (!calls.length) {
          if (output.content && !streamedEvent) this.event(current, "assistant", output.content);
          this.save(current);
          await this.handleNoTool(id, token);
          if (this.load(id).run?.status !== "running") break;
          continue;
        }

        if (output.content && !streamedEvent) this.event(current, "assistant", output.content, { modelTurnId });
        calls.forEach((call, index) => this.event(current, "tool_call", call.name, {
          modelTurnId, toolCallId: call.id, name: call.name, arguments: call.arguments, index, count: calls.length,
          ...(call.rawArguments !== undefined ? { rawArguments: call.rawArguments } : {}),
          ...(call.argumentError ? { argumentError: call.argumentError } : {}),
        }));
        this.save(current);
        const outcome = await this.executeBatch(id, calls, { ...token, modelTurnId });
        if (outcome === "waiting") break;
      }
      const last = this.load(id);
      if (last.run?.status === "running") this.pauseRun(last, "达到本轮上限，已暂停。");
      this.save(last);
    } catch (error) {
      const failed = this.load(id);
      if (failed.run?.status === "running") {
        failed.run.status = "failed";
        failed.run.error = error instanceof Error ? error.message : String(error);
        this.touch(failed.run);
        this.event(failed, "status", failed.run.error, { status: "failed" });
        this.save(failed);
      }
    } finally {
      this.active.delete(id);
      if (this.load(id).run?.status === "running") this.schedule(id);
    }
  }

  private async executeBatch(id: string, calls: AgentToolCall[], token: TurnToken): Promise<"continue" | "waiting"> {
    for (let index = 0; index < calls.length; index += 1) {
      const snapshot = this.load(id);
      if (!this.current(snapshot, token)) {
        this.cancelCalls(snapshot, calls.slice(index), token, "本轮未执行：用户要求或运行状态已经变化。");
        this.save(snapshot);
        return snapshot.run?.status === "running" ? "continue" : "waiting";
      }
      const outcome = await this.toolRunner.execute(id, calls[index]!, token);
      if (outcome !== "continue") {
        const fresh = this.load(id);
        this.cancelCalls(fresh, calls.slice(index + (outcome === "stale" ? 0 : 1)), token,
          "本轮未执行：正在等待用户输入、授权或新的要求。");
        this.save(fresh);
        return fresh.run?.status === "running" ? "continue" : "waiting";
      }
    }
    return "continue";
  }

  private async handleNoTool(id: string, token: TurnToken): Promise<void> {
    let snapshot = this.load(id);
    if (!this.current(snapshot, token) || !snapshot.run) return;
    const results = snapshot.events.filter((event) => event.runId === snapshot.run!.id && event.type === "tool_result");
    const hadWrites = results.some((event) => event.data?.write === true);
    const hadRemoteWrites = results.some((event) => event.data?.remoteWrite === true);
    if (!hadWrites) { this.finish(snapshot); this.save(snapshot); return; }
    if (!this.deps.finishVerified) {
      if (!hadRemoteWrites) this.finish(snapshot);
      else this.completionBlocked(snapshot, "远端写入尚未配置权威完成检查，不能标记为完成。");
      this.save(snapshot);
      return;
    }
    const gate = await this.deps.finishVerified(id, { runId: snapshot.run.id, hadWrites, hadRemoteWrites });
    snapshot = this.load(id);
    if (!this.current(snapshot, token)) return;
    if (gate.verified) { this.finish(snapshot); this.save(snapshot); return; }
    if (gate.finalApproval) {
      const identity = await this.deps.accountFor(id);
      snapshot = this.load(id);
      if (!this.current(snapshot, token)) return;
      this.createApproval(snapshot, cleanList(gate.finalApproval.scope), gate.finalApproval.summary.trim(), identity);
      this.save(snapshot);
      return;
    }
    this.completionBlocked(snapshot, gate.message ?? "写入尚未完成权威核对，请查询并继续。");
    this.save(snapshot);
  }

  private async messages(snapshot: AgentSnapshot): Promise<AgentModelMessage[]> {
    const context = await this.deps.contextFor?.(snapshot.localProductId) ?? "";
    return buildModelMessages(
      `你是旅行产品操作助手。${context}\n外部写入前必须请求精确范围授权，远端写入后必须读回验证。`,
      snapshot.events,
    );
  }

  private schemas() {
    return [...this.deps.tools.map(({ name, description, parameters, write }) => ({ name, description, parameters, write })), ...nativeToolSchemas()];
  }

  private createApproval(snapshot: AgentSnapshot, scope: string[], summary: string,
    identity: { accountKey: string; productVersion: string }, toolCallId?: string, runId?: string): void {
    this.snapshots.createApproval(snapshot, scope, summary, identity, toolCallId, runId);
  }
  private cancelPendingInteraction(snapshot: AgentSnapshot, reason: string): void { this.snapshots.cancelPendingInteraction(snapshot, reason); }
  private cancelCalls(snapshot: AgentSnapshot, calls: AgentToolCall[], token: TurnToken, content: string): void {
    this.snapshots.cancelCalls(snapshot, calls, token, content);
  }
  private blockedResult(snapshot: AgentSnapshot, toolCallId: string, message: string, blocker: NoProgressBlocker,
    data?: Record<string, unknown>, runId?: string): void {
    this.snapshots.blockedResult(snapshot, toolCallId, message, blocker, data, runId);
  }
  private completionBlocked(snapshot: AgentSnapshot, message: string, blocker?: NoProgressBlocker): void {
    this.snapshots.completionBlocked(snapshot, message, blocker);
  }
  private pendingCallId(snapshot: AgentSnapshot, type: AgentEventType, interactionId: string): string | undefined {
    return this.snapshots.pendingCallId(snapshot, type, interactionId);
  }
  private token(snapshot: AgentSnapshot): TurnToken { return this.snapshots.token(snapshot); }
  private current(snapshot: AgentSnapshot, token: TurnToken): boolean { return this.snapshots.current(snapshot, token); }

  private async model(id: string) {
    const model = await this.deps.modelFor?.(id) ?? this.deps.model;
    if (!model) throw new Error("未配置 AI 模型。");
    return model;
  }
  private load(id: string): AgentSnapshot { return this.snapshots.load(id); }
  private save(snapshot: AgentSnapshot): AgentSnapshot { return this.snapshots.save(snapshot); }
  private event(snapshot: AgentSnapshot, type: AgentEvent["type"], content: string, data?: Record<string, unknown>, runId?: string): void {
    this.snapshots.event(snapshot, type, content, data, runId);
  }
  private result(snapshot: AgentSnapshot, toolCallId: string, content: string, data?: Record<string, unknown>, runId?: string): void {
    this.snapshots.result(snapshot, toolCallId, content, data, runId);
  }
  private run(status: AgentRunStatus): AgentRun { return this.snapshots.newRun(status); }
  private touch(run: AgentRun): void { this.snapshots.touch(run); }
  private running(snapshot: AgentSnapshot): void { this.snapshots.running(snapshot); }
  private waiting(snapshot: AgentSnapshot, status: "waiting_input" | "waiting_approval"): void { this.snapshots.waiting(snapshot, status); }
  private pauseRun(snapshot: AgentSnapshot, content: string): void { this.snapshots.pause(snapshot, content); }
  private finish(snapshot: AgentSnapshot): void { this.snapshots.finish(snapshot); }
  private terminal(status: AgentRunStatus): boolean { return this.snapshots.terminal(status); }
  private async intent(id: string): Promise<string> {
    const product = await this.deps.productFingerprint?.(id) ?? "local";
    return `${product}:${this.id()}`;
  }

  private async command<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.commandTails.set(id, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.commandTails.get(id) === tail) this.commandTails.delete(id); }
  }
}
