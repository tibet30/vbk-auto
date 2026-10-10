import type { AgentSnapshot } from "../../shared/contracts.js";
import { completeWithRetries } from "./core-model.js";
import { trackProductExecution } from "../operations/product-execution-clock.js";
import { AgentSnapshotManager, materialWriteResults, type AgentStreamState, type TurnToken } from "./core-snapshot.js";
import { AgentToolRunner } from "./core-tools.js";
import { buildModelMessages } from "./core-transcript.js";
import { cleanList, nativeToolSchemas } from "./core-validation.js";
import { formatToolCallPreamble } from "./tool-call-preamble.js";
import { nextPreparationLoopDecision } from "./core-preparation.js";
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
        const preparation = nextPreparationLoopDecision(this.deps, before);
        const isPreparationRepairWindow = preparation.kind === "model"
          && (Boolean(preparation.action) || preparation.manualPoiModelWindow === true);
        if (preparation.kind === "pause") {
          this.snapshots.pause(before, preparation.reason);
          if (preparation.manualPoiBlocked) {
            const pause = before.events.at(-1);
            if (pause?.type === "status") pause.data = {
              ...pause.data, manualPoiBlocked: true, poiSlotKey: preparation.poiSlotKey,
              manualPoiAnswerSlotKey: preparation.manualPoiAnswerSlotKey,
            };
          }
          this.snapshots.save(before);
          break;
        }
        if (preparation.kind === "execute") {
          const call: AgentToolCall = { id: this.id(), name: preparation.action.name, arguments: preparation.action.arguments };
          this.snapshots.event(before, "status", `自动推进本地准备：${preparation.action.node}`, {
            deterministicPreparation: true,
            node: preparation.action.node,
            progressKey: preparation.action.progressKey,
            name: preparation.action.name,
          }, token.runId);
          this.snapshots.event(before, "tool_call", call.name, {
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
            index: 0,
            count: 1,
            deterministicPreparation: true,
            node: preparation.action.node,
            progressKey: preparation.action.progressKey,
          }, token.runId);
          this.snapshots.save(before);
          const outcome = await this.toolRunner.execute(id, call, token);
          if (outcome !== "continue") break;
          continue;
        }
        if (preparation.kind === "askHotelInput") {
          const call: AgentToolCall = { id: this.id(), name: "ask_user", arguments: { questions: preparation.questions } };
          this.snapshots.event(before, "tool_call", call.name, {
            toolCallId: call.id, name: call.name, arguments: call.arguments, index: 0, count: 1,
            hotelAvailabilityInput: true, node: preparation.action.node, progressKey: preparation.action.progressKey,
          }, token.runId);
          this.snapshots.save(before);
          const outcome = await this.toolRunner.execute(id, call, token);
          if (outcome !== "continue") break;
          continue;
        }
        if (preparation.kind === "askPoiInput") {
          const call: AgentToolCall = { id: this.id(), name: "ask_user", arguments: { questions: [preparation.input.question] } };
          this.snapshots.event(before, "status", "未找到独立 POI，正在由 AI 自动判断名称和同日地点锚点。", {
            manualPoiInput: true, node: preparation.action.node, progressKey: preparation.action.progressKey,
            poiSlotKey: preparation.input.key, poiSlots: preparation.input.slots,
          }, token.runId);
          this.snapshots.event(before, "tool_call", call.name, {
            toolCallId: call.id, name: call.name, arguments: call.arguments, index: 0, count: 1,
            manualPoiInput: true, node: preparation.action.node, progressKey: preparation.action.progressKey,
            poiSlotKey: preparation.input.key, poiSlots: preparation.input.slots,
          }, token.runId);
          this.snapshots.save(before);
          const outcome = await this.toolRunner.execute(id, call, token);
          if (outcome !== "continue") break;
          continue;
        }
        if (preparation.modelRepairWindow) {
          this.snapshots.event(before, "status", `当前节点 ${preparation.action!.node} 已自动尝试两次。请基于前两次真实工具结果和当前保存事实在最多三轮内读取并修复，不能只询问是否继续；必须保留锁定城市、天数和已绑定 POI。`, {
            deterministicPreparationModelRepair: true,
            modelFeedback: true,
            node: preparation.action!.node,
            progressKey: preparation.action!.progressKey,
            name: preparation.action!.name,
          }, token.runId);
          this.snapshots.save(before);
        }
        if (preparation.manualPoiModelWindow) {
          this.snapshots.event(before, "status", "请根据用户补充先调用 query_poi 查询新名称（多项可逐一查询），再调用 select_itinerary_poi 逐个绑定原行程槽位；不得改动景点名、日次、顺序、relation，也不得猜测 POI ID。", {
            manualPoiModelWindow: true, modelFeedback: true, node: preparation.action!.node,
            progressKey: preparation.action!.progressKey, poiSlotKey: preparation.poiSlotKey,
            manualPoiAnswerSlotKey: preparation.manualPoiAnswerSlotKey,
          }, token.runId);
          this.snapshots.save(before);
        }
        if (preparation.hotelInputModelWindow) {
          this.snapshots.event(before, "status", "酒店资料已回答，请读取该答案并用 patch_product 和 resolve_itinerary_hotels 落实到真实住宿候选；不能重复 ask_user，不能猜测酒店 ID、改变用户明确的住宿地点或只回复检索策略。", {
            hotelInputModelWindow: true, modelFeedback: true, node: preparation.action!.node,
            progressKey: preparation.action!.progressKey,
          }, token.runId);
          this.snapshots.save(before);
        }
        const messages = await this.messages(before);
        if (!this.snapshots.current(this.snapshots.load(id), token)) continue;
        const model = await this.model(id);
        if (!this.snapshots.current(this.snapshots.load(id), token)) continue;

        const modelTurnId = this.id();
        const streamState: AgentStreamState = { lastSavedAt: 0 };
        let output;
        try {
          output = await trackProductExecution(id, () => completeWithRetries(model, {
            messages, tools: this.schemas(),
            onContent: (content) => this.snapshots.publishStreaming(id, token, modelTurnId, streamState, content),
          }, id));
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
          if (output.content && !streamedEvent) this.snapshots.event(current, "assistant", output.content, { modelTurnId });
          this.snapshots.save(current);
          // A repair-window answer with no tool has not changed the saved
          // product. Let the bounded preparation controller record its own
          // concrete pause instead of treating a prior local tool failure as
          // a generic completion attempt.
          if (isPreparationRepairWindow) continue;
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
    const preparationRequired = this.deps.requiresCompletionVerification?.(id, snapshot) ?? false;
    if (!hadWrites && !preparationRequired) { this.snapshots.finish(snapshot); this.snapshots.save(snapshot); return; }
    if (!this.deps.finishVerified) {
      if (!hadRemoteWrites && !preparationRequired) this.snapshots.finish(snapshot);
      else this.snapshots.completionBlocked(snapshot, "远端写入尚未配置权威完成检查，不能标记为完成。");
      this.snapshots.save(snapshot);
      return;
    }
    const gate = await this.deps.finishVerified(id, { runId: snapshot.run.id, hadWrites, hadRemoteWrites });
    snapshot = this.snapshots.load(id);
    if (!this.snapshots.current(snapshot, token)) return;
    if (gate.verified) { this.snapshots.finish(snapshot, true); this.snapshots.save(snapshot); return; }
    if (gate.finalApproval) {
      const identity = await this.deps.accountFor(id);
      snapshot = this.snapshots.load(id);
      if (!this.snapshots.current(snapshot, token)) return;
      this.snapshots.createApproval(snapshot, cleanList(gate.finalApproval.scope), gate.finalApproval.summary.trim(), identity);
      this.snapshots.save(snapshot);
      return;
    }
    if (gate.pauseReason) {
      this.snapshots.pause(snapshot, gate.pauseReason);
      this.snapshots.save(snapshot);
      return;
    }
    this.snapshots.completionBlocked(snapshot, (preparationRequired
      ? "用户已授权本地规划，请继续完成本地准备，无需再次要求回复继续。" : '')
      + (gate.message ?? "写入尚未完成权威核对，请查询并继续。"));
    this.snapshots.save(snapshot);
  }

  private async messages(snapshot: AgentSnapshot): Promise<AgentModelMessage[]> {
    const context = await this.deps.contextFor?.(snapshot.localProductId) ?? "";
    return buildModelMessages(
      `你是旅行产品操作助手。${context}\n外部写入前必须请求精确范围授权，远端写入后必须读回验证。\n`
        + "交互方式：执行期间持续简述正在做什么、工具返回了什么以及后续动作；无需用户决策时自动继续。"
        + "调用 ask_user 时在 summary 中总结本阶段已完成的事、结果、待决定事项和回答后的下一步，再提供明确问题。"
        + "request_approval 的 summary 要说明已完成的方案与待确认范围。"
        + "全部工作完成时输出整个请求的最终总结：成果、关键用户决定、验证依据、剩余事项和下一步。"
        + "暂停、受阻或等待授权不等于任务完成；不得把计划、未保存或未回读的结果描述成已完成。",
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
