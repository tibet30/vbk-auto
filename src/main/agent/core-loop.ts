import type { AgentSnapshot } from "../../shared/contracts.js";
import { completeWithRetries } from "./core-model.js";
import { AgentSnapshotManager, materialWriteResults, type AgentStreamState, type TurnToken } from "./core-snapshot.js";
import { AgentToolRunner } from "./core-tools.js";
import { buildModelMessages } from "./core-transcript.js";
import { cleanList, nativeToolSchemas } from "./core-validation.js";
import { formatToolCallPreamble } from "./tool-call-preamble.js";
import type { AgentCoreDependencies, AgentModelMessage, AgentToolCall } from "./types.js";

/** Model-turn scheduler: tool batches, completion gate, and round limit. */
export class AgentTurnLoop {
  constructor(
    private readonly deps: AgentCoreDependencies,
    private readonly snapshots: AgentSnapshotManager,
    private readonly toolRunner: AgentToolRunner,
    private readonly id: () => string,
    private readonly active: Set<string>,
    private readonly scheduled: Set<string>,
  ) {}

  schedule(id: string): void {
    if (this.active.has(id) || this.scheduled.has(id)) return;
    this.scheduled.add(id);
    queueMicrotask(() => { this.scheduled.delete(id); void this.drive(id); });
  }

  private async drive(id: string): Promise<void> {
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      for (let round = 0; round < 80; round += 1) {
        const before = this.snapshots.load(id);
        if (before.run?.status !== "running" || before.uncertainWrite) break;
        const token = this.snapshots.token(before);
        const messages = await this.messages(before);
        if (!this.snapshots.current(this.snapshots.load(id), token)) continue;
        const model = await this.model(id);
        if (!this.snapshots.current(this.snapshots.load(id), token)) continue;

        const modelTurnId = this.id();
        const streamState: AgentStreamState = { lastSavedAt: 0 };
        let output;
        try {
          output = await completeWithRetries(model, {
            messages, tools: this.schemas(),
            onContent: (content) => this.snapshots.publishStreaming(id, token, modelTurnId, streamState, content),
          });
        } catch (error) {
          const failed = this.snapshots.load(id);
          if (!this.snapshots.current(failed, token)) continue;
          this.snapshots.interruptStreaming(failed, "生成中断，请重试。", modelTurnId);
          if (failed.run) {
            failed.run.status = "failed";
            failed.run.error = error instanceof Error ? error.message : String(error);
            this.snapshots.touch(failed.run);
            this.snapshots.event(failed, "status", failed.run.error, { status: "failed" });
          }
          this.snapshots.save(failed);
          break;
        }

        const current = this.snapshots.load(id);
        if (!this.snapshots.current(current, token)) continue;
        const calls = output.toolCalls ?? [];
        const streamedEvent = current.events.find((event) => event.id === streamState.eventId);
        if (!calls.length) {
          if (streamedEvent && output.content) {
            streamedEvent.content = output.content;
            streamedEvent.data = { ...streamedEvent.data, streaming: false };
          } else if (streamedEvent) {
            current.events = current.events.filter((event) => event.id !== streamedEvent.id);
          }
          if (output.content && !streamedEvent) this.snapshots.event(current, "assistant", output.content);
          this.snapshots.save(current);
          await this.handleNoTool(id, token);
          if (this.snapshots.load(id).run?.status !== "running") break;
          continue;
        }

        const toolPreamble = (output.content?.trim() ? output.content : formatToolCallPreamble(calls)).trim();
        if (streamedEvent) {
          streamedEvent.content = toolPreamble;
          streamedEvent.data = {
            ...streamedEvent.data,
            streaming: false,
            ...(!output.content?.trim() ? { generatedToolPreamble: true } : {}),
          };
        } else if (output.content && !streamedEvent) {
          this.snapshots.event(current, "assistant", output.content, { modelTurnId });
        } else if (!streamedEvent) {
          this.snapshots.event(current, "assistant", toolPreamble, { modelTurnId, generatedToolPreamble: true });
        }
        calls.forEach((call, index) => this.snapshots.event(current, "tool_call", call.name, {
          modelTurnId, toolCallId: call.id, name: call.name, arguments: call.arguments, index, count: calls.length,
          ...(call.rawArguments !== undefined ? { rawArguments: call.rawArguments } : {}),
          ...(call.argumentError ? { argumentError: call.argumentError } : {}),
        }));
        this.snapshots.save(current);
        const outcome = await this.executeBatch(id, calls, { ...token, modelTurnId });
        if (outcome === "waiting") break;
      }
      const last = this.snapshots.load(id);
      if (last.run?.status === "running") this.snapshots.pause(last, "达到本轮上限，已暂停。");
      this.snapshots.save(last);
    } catch (error) {
      const failed = this.snapshots.load(id);
      if (failed.run?.status === "running") {
        failed.run.status = "failed";
        failed.run.error = error instanceof Error ? error.message : String(error);
        this.snapshots.touch(failed.run);
        this.snapshots.event(failed, "status", failed.run.error, { status: "failed" });
        this.snapshots.save(failed);
      }
    } finally {
      this.active.delete(id);
      if (this.snapshots.load(id).run?.status === "running") this.schedule(id);
    }
  }

  private async executeBatch(id: string, calls: AgentToolCall[], token: TurnToken): Promise<"continue" | "waiting"> {
    for (let index = 0; index < calls.length; index += 1) {
      const snapshot = this.snapshots.load(id);
      if (!this.snapshots.current(snapshot, token)) {
        this.snapshots.cancelCalls(snapshot, calls.slice(index), token, "本轮未执行：用户要求或运行状态已经变化。");
        this.snapshots.save(snapshot);
        return snapshot.run?.status === "running" ? "continue" : "waiting";
      }
      const outcome = await this.toolRunner.execute(id, calls[index]!, token);
      if (outcome !== "continue") {
        const fresh = this.snapshots.load(id);
        this.snapshots.cancelCalls(fresh, calls.slice(index + (outcome === "stale" ? 0 : 1)), token,
          "本轮未执行：正在等待用户输入、授权或新的要求。");
        this.snapshots.save(fresh);
        return fresh.run?.status === "running" ? "continue" : "waiting";
      }
    }
    return "continue";
  }

  private async handleNoTool(id: string, token: TurnToken): Promise<void> {
    let snapshot = this.snapshots.load(id);
    if (!this.snapshots.current(snapshot, token) || !snapshot.run) return;
    const writes = materialWriteResults(snapshot, snapshot.run.id);
    const hadWrites = writes.length > 0;
    const hadRemoteWrites = writes.some((event) => event.data?.remoteWrite === true);
    if (!hadWrites) { this.snapshots.finish(snapshot); this.snapshots.save(snapshot); return; }
    if (!this.deps.finishVerified) {
      if (!hadRemoteWrites) this.snapshots.finish(snapshot);
      else this.snapshots.completionBlocked(snapshot, "远端写入尚未配置权威完成检查，不能标记为完成。");
      this.snapshots.save(snapshot);
      return;
    }
    const gate = await this.deps.finishVerified(id, { runId: snapshot.run.id, hadWrites, hadRemoteWrites });
    snapshot = this.snapshots.load(id);
    if (!this.snapshots.current(snapshot, token)) return;
    if (gate.verified) { this.snapshots.finish(snapshot); this.snapshots.save(snapshot); return; }
    if (gate.finalApproval) {
      const identity = await this.deps.accountFor(id);
      snapshot = this.snapshots.load(id);
      if (!this.snapshots.current(snapshot, token)) return;
      this.snapshots.createApproval(snapshot, cleanList(gate.finalApproval.scope), gate.finalApproval.summary.trim(), identity);
      this.snapshots.save(snapshot);
      return;
    }
    this.snapshots.completionBlocked(snapshot, gate.message ?? "写入尚未完成权威核对，请查询并继续。");
    this.snapshots.save(snapshot);
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

  private async model(id: string) {
    const model = await this.deps.modelFor?.(id) ?? this.deps.model;
    if (!model) throw new Error("未配置 AI 模型。");
    return model;
  }
}
