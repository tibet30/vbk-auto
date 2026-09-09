import type { AgentApproval, AgentSnapshot } from "../../shared/contracts.js";
import type { AgentSnapshotManager } from "./core-snapshot.js";
import type { AgentCoreDependencies } from "./types.js";

type Command = <T>(id: string, operation: () => Promise<T>) => Promise<T>;

/** Deterministic VBK handoff lifecycle, kept off the model turn loop. */
export class AgentHandoff {
  private readonly ids = new Set<string>();

  constructor(
    private readonly deps: AgentCoreDependencies,
    private readonly snapshots: AgentSnapshotManager,
    private readonly command: Command,
  ) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  isDeterministic(approval: AgentApproval | undefined): boolean {
    return Boolean(approval?.scope.some((scope) => scope.startsWith("vbk.write_phase:")));
  }

  tryStart(id: string, approval: AgentApproval): boolean {
    if (!this.isDeterministic(approval)) return false;
    if (this.ids.has(id)) return true;
    const accepted = this.deps.handoffApprovedWorkflow?.(id, approval) === true;
    if (accepted) this.ids.add(id);
    return accepted;
  }

  async complete(id: string, approvalId: string): Promise<AgentSnapshot> {
    this.ids.delete(id);
    const identity = await this.deps.accountFor(id);
    return this.command(id, async () => {
      let snapshot = this.snapshots.load(id);
      const approval = this.snapshots.validApproval(snapshot);
      // Automation may rewrite presentation/resources after approval. Do not
      // require the pre-write fingerprint; refresh it and reuse the shared gate.
      if (!approval || approval.id !== approvalId || approval.accountKey !== identity.accountKey
        || !snapshot.run || this.snapshots.terminal(snapshot.run.status)) return snapshot;
      approval.productVersion = identity.productVersion;
      this.snapshots.save(snapshot);
      if (this.deps.finishVerified) {
        const gate = await this.deps.finishVerified(id, {
          runId: snapshot.run.id,
          hadWrites: true,
          hadRemoteWrites: true,
          deterministicWorkflow: true,
        });
        snapshot = this.snapshots.load(id);
        if (!gate.verified) {
          this.snapshots.pause(snapshot, gate.message ?? "自动录入完成核对未通过，请继续处理。");
          return this.snapshots.save(snapshot);
        }
      }
      this.snapshots.event(snapshot, "status", "已按本次授权完成全部 VBK 阶段并通过最终回读。", { deterministicWorkflow: true });
      this.snapshots.finish(snapshot);
      return this.snapshots.save(snapshot);
    });
  }

  async pause(id: string, approvalId: string, message: string): Promise<AgentSnapshot> {
    this.ids.delete(id);
    let identity: { accountKey: string; productVersion: string } | undefined;
    try {
      identity = await this.deps.accountFor(id);
    } catch {
      identity = undefined;
    }
    return this.command(id, async () => {
      const snapshot = this.snapshots.load(id);
      const approval = this.snapshots.validApproval(snapshot);
      if (!approval || approval.id !== approvalId || !snapshot.run || this.snapshots.terminal(snapshot.run.status)) {
        return snapshot;
      }
      // Keep the authorised intent usable after automation rewrote local fields.
      if (identity && approval.accountKey === identity.accountKey) {
        approval.productVersion = identity.productVersion;
      }
      this.snapshots.pause(snapshot, `自动录入已暂停：${message}`);
      this.snapshots.event(snapshot, "status", "已保留已完成阶段；恢复时将从失败阶段继续，不会重新请求授权。", {
        deterministicWorkflow: true,
      });
      return this.snapshots.save(snapshot);
    });
  }

  async refreshFingerprint(id: string, approval: AgentApproval): Promise<void> {
    try {
      const identity = await this.deps.accountFor(id);
      const snapshot = this.snapshots.load(id);
      const current = this.snapshots.validApproval(snapshot);
      if (!current || current.id !== approval.id || current.accountKey !== identity.accountKey) return;
      current.productVersion = identity.productVersion;
      this.snapshots.save(snapshot);
    } catch {
      // Keep the existing fingerprint when the account cannot be verified yet.
    }
  }

  async recover(id: string, snapshot: AgentSnapshot): Promise<AgentApproval | undefined> {
    const current = this.snapshots.validApproval(snapshot);
    if (!this.deps.recoverApproval) return current;
    const recovered = await this.deps.recoverApproval(id, structuredClone(snapshot));
    if (!recovered) return current;
    const event = [...snapshot.events].reverse().find((item) =>
      item.type === "approval" && (item.data?.approval as AgentApproval | undefined)?.id === recovered.id);
    if (event) event.data = { ...(event.data ?? {}), approval: recovered, recoveredApproval: true };
    return recovered;
  }
}
