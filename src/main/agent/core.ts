import type {
  AgentApproval, AgentApprovalResponse, AgentEvent, AgentEventType,
  AgentIllegalKeywordRepairInput, AgentInputResponse, AgentRun, AgentRunStatus, AgentSnapshot,
} from "../../shared/contracts.js";
import { isPendingApprovalStatusFollowup, preservesApprovedIntent } from "./approval-intent.js";
import { AgentHandoff } from "./core-handoff.js";
import { AgentTurnLoop } from "./core-loop.js";
import { AgentSnapshotManager, type NoProgressBlocker } from "./core-snapshot.js";
import { AgentToolRunner } from "./core-tools.js";
import { validateAnswers } from "./core-validation.js";
import type { AgentCoreDependencies, AgentSnapshotStore } from "./types.js";

export type { AgentSnapshotStore } from "./types.js";
export { isPendingApprovalStatusFollowup, preservesApprovedIntent } from "./approval-intent.js";

export class AgentCore {
  private readonly active = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly snapshots: AgentSnapshotManager;
  private readonly toolRunner: AgentToolRunner;
  private readonly handoffs: AgentHandoff;
  private readonly loop: AgentTurnLoop;

  constructor(private readonly deps: AgentCoreDependencies, store: AgentSnapshotStore) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => crypto.randomUUID());
    this.snapshots = new AgentSnapshotManager(store, this.now, this.id);
    this.toolRunner = new AgentToolRunner(deps, this.snapshots, this.now, this.id);
    this.handoffs = new AgentHandoff(deps, this.snapshots, (id, operation) => this.command(id, operation));
    this.loop = new AgentTurnLoop(deps, this.snapshots, this.toolRunner, this.id, this.active, this.scheduled);
  }

  async get(id: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const snapshot = this.load(id);
      const detached = !this.active.has(id) && !this.scheduled.has(id);
      // `handoffApprovedWorkflow` is deliberately detached from the model
      // turn. Renderer polling must not mistake that short interval for an
      // application restart and pause the freshly authorised first phase.
      const handingOff = this.handoffs.has(id);
      if (detached && !handingOff) this.snapshots.recoverInterruptedCalls(snapshot);
      if (detached && !handingOff) this.snapshots.interruptStreaming(snapshot, "应用中断，回复未完成。");
      if (snapshot.run?.status === "running" && detached && !handingOff) {
        this.pauseRun(snapshot, "应用重启后已在安全检查点暂停。");
      }
      if (snapshot.pendingApproval?.status === "pending") {
        const blocker = await this.deps.approvalPrecondition?.(id, snapshot.pendingApproval.scope);
        if (blocker) {
          this.cancelPendingInteraction(snapshot, `最终确认已失效：${blocker}`);
          if (snapshot.run && !this.terminal(snapshot.run.status)) {
            this.pauseRun(snapshot, `最终确认已失效：${blocker}。请继续执行，系统会从缺失项自动修复。`);
          }
        }
      }
      return this.save(snapshot);
    });
  }

  async send(id: string, content: string): Promise<AgentSnapshot> {
    return this.command(id, async () => {
      const text = content.trim();
      if (!text) return this.load(id);
      let snapshot = this.load(id);
      if (!this.active.has(id) && !this.scheduled.has(id)) this.snapshots.recoverInterruptedCalls(snapshot);
      if (snapshot.pendingApproval && isPendingApprovalStatusFollowup(text)) {
        const precondition = await this.deps.approvalPrecondition?.(id, snapshot.pendingApproval.scope);
        snapshot = this.load(id);
        if (!precondition && snapshot.pendingApproval) {
          this.snapshots.interruptStreaming(snapshot, "已收到对待处理状态的追问。");
          this.event(snapshot, "user", text, { pendingApprovalRetained: true });
          this.event(snapshot, "assistant", "当前方案已通过本地校验，原最终确认仍有效；无需重新生成推荐理由或重新申请确认。", {
            pendingApprovalRetained: true,
          });
          this.waiting(snapshot, "waiting_approval");
          return this.save(snapshot);
        }
        // Plan is no longer phase-A ready: drop the stale card and continue as a
        // normal turn so the model can finish local prep before re-requesting.
      }
      await this.deps.prepareUserInstruction?.(id, text);
      const recoveryInstruction = preservesApprovedIntent(text);
      let approved = this.snapshots.validApproval(snapshot);
      if (recoveryInstruction) approved = await this.handoffs.recover(id, snapshot) ?? approved;
      const preserveIntent = recoveryInstruction && Boolean(approved);
      const intentVersion = preserveIntent ? snapshot.run!.intentVersion : await this.intent(id);
      this.snapshots.interruptStreaming(snapshot, "已由新的要求中止。");
      this.cancelPendingInteraction(snapshot, "新请求已替代此前等待中的交互。");
      const startsNewRun = !snapshot.run || this.terminal(snapshot.run.status);
      if (startsNewRun) {
        snapshot = { ...snapshot, run: this.run("queued"), pendingInput: undefined, pendingApproval: undefined };
      }
      snapshot.run!.intentVersion = intentVersion;
      snapshot.run!.error = undefined;
      if (startsNewRun && preserveIntent && approved) {
        this.event(snapshot, "approval", "已复用既有授权", {
          approval: approved,
          recoveredApproval: true,
        });
      }
      this.event(snapshot, "user", text, preserveIntent ? { approvalPreservingRecovery: true } : undefined);
      if (snapshot.uncertainWrite) this.pauseRun(snapshot, "写入结果尚未权威核对；已保存新要求，核对后才能继续。");
      else this.running(snapshot);
      const saved = this.save(snapshot);
      if (saved.run?.status !== "running") return saved;
      if (preserveIntent && approved && this.handoffs.isDeterministic(approved)) {
        await this.handoffs.refreshFingerprint(id, approved);
        const ready = this.snapshots.validApproval(this.load(id)) ?? approved;
        if (this.handoffs.tryStart(id, ready)) return this.load(id);
        const paused = this.load(id);
        this.pauseRun(paused, "已确认方案的自动录入未能重新启动；请再次点击继续执行，不会改回 AI 规划。");
        return this.save(paused);
      }
      if (!(preserveIntent && approved && this.handoffs.tryStart(id, approved))) this.loop.schedule(id);
      return this.load(id);
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
      this.loop.schedule(id);
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
      this.loop.schedule(id);
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
      let granted: AgentApproval | undefined;
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
        granted = approval;
        snapshot.pendingApproval = undefined;
        this.event(snapshot, "approval", "用户已授权", { approval });
        if (toolCallId) this.result(snapshot, toolCallId, "授权已确认。", { approval });
      }
      if (snapshot.run?.status !== "paused") this.running(snapshot);
      const saved = this.save(snapshot);
      if (saved.run?.status === "running" && !(granted && this.handoffs.tryStart(id, granted))) this.loop.schedule(id);
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
      if (snapshot.pendingApproval) {
        const blocker = await this.deps.approvalPrecondition?.(id, snapshot.pendingApproval.scope);
        snapshot = this.load(id);
        if (!snapshot.pendingApproval) return snapshot;
        if (!blocker) {
          this.waiting(snapshot, "waiting_approval");
          return this.save(snapshot);
        }
        this.cancelPendingInteraction(snapshot, `最终确认已失效：${blocker}`);
        this.event(snapshot, "status", `最终确认已失效：${blocker}。继续从缺失项自动修复。`, {
          noProgressBlocker: "approval_precondition",
        });
      }
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
      // The product-list recovery button does not create a new user message.
      // Treat it as an operational retry and migrate an equivalent historical
      // approval before the next write is evaluated.
      await this.handoffs.recover(id, snapshot);
      if (openRetryWindow) this.snapshots.openNoProgressRetryWindow(snapshot);
      snapshot.run!.error = undefined;
      this.running(snapshot);
      const saved = this.save(snapshot);
      const approval = this.snapshots.validApproval(saved);
      if (approval && this.handoffs.isDeterministic(approval)) {
        // Phase B resume must never fall back to the model loop.
        await this.handoffs.refreshFingerprint(id, approval);
        const ready = this.snapshots.validApproval(this.load(id)) ?? approval;
        if (this.handoffs.tryStart(id, ready)) return this.load(id);
        const paused = this.load(id);
        this.pauseRun(paused, "已确认方案的自动录入未能重新启动；请再次点击继续执行，不会改回 AI 规划。");
        return this.save(paused);
      }
      if (!(approval && this.handoffs.tryStart(id, approval))) this.loop.schedule(id);
      return this.load(id);
    });
  }

  async completeApprovedWorkflow(id: string, approvalId: string): Promise<AgentSnapshot> {
    return this.handoffs.complete(id, approvalId);
  }

  async pauseApprovedWorkflow(id: string, approvalId: string, message: string): Promise<AgentSnapshot> {
    return this.handoffs.pause(id, approvalId, message);
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

  private cancelPendingInteraction(snapshot: AgentSnapshot, reason: string): void { this.snapshots.cancelPendingInteraction(snapshot, reason); }
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
