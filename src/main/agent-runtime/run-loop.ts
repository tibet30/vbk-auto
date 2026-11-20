/**
 * 多步模型—工具循环。
 *
 * 协议约束：一轮模型回复最多驱动一个动作。这样 `waiting_approval` 才是真正的
 * 持久化暂停点——transcript 永远停在「assistant 提出一次工具调用」之后，
 * 恢复时只需补上它的结果即可继续，不会出现缺失 tool result 的半截对话。
 */

import type {
  AgentRun,
  AgentToolCallRecord,
} from "../../shared/contracts-agent-runtime.js";
import { describeAgentFailure, toAgentFailureError } from "../agent/agent-failure.js";
import type { AgentModel, AgentModelMessage, AgentToolCall } from "../agent/types.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { toolCallIdempotencyKey, type ActionExecutor } from "./action-executor.js";
import { evaluatePermission } from "./permission-policy.js";
import type { AgentSkillRegistry } from "./skill-registry.js";
import type { AgentSkillContext } from "./types.js";
import type { AgentTranscriptEntry } from "../infrastructure/database/parts/agent-runtime.js";

export interface AgentRunProvider {
  model: AgentModel;
  systemPrompt: string;
}

export interface AdvanceAgentRunInput {
  db: VbkDatabase;
  registry: AgentSkillRegistry;
  executor: ActionExecutor;
  ownerUserId: number;
  threadId: string;
  runId: string;
  /** 线程历史（已压缩），每次推进都重新读取，避免用旧上下文覆盖新消息。 */
  history: AgentModelMessage[];
  context: AgentSkillContext;
  provider: () => Promise<AgentRunProvider>;
}

export interface AdvanceAgentRunResult {
  run: AgentRun;
  pendingToolCall?: AgentToolCallRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolResult(toolCallId: string, content: string): AgentModelMessage {
  return { role: "tool", content, toolCallId };
}

export function loadTranscript(
  db: VbkDatabase,
  ownerUserId: number,
  runId: string,
): AgentModelMessage[] {
  return db.getAgentRunTranscript(ownerUserId, runId) as unknown as AgentModelMessage[];
}

export function saveTranscript(
  db: VbkDatabase,
  ownerUserId: number,
  runId: string,
  transcript: readonly AgentModelMessage[],
): void {
  db.saveAgentRunTranscript(ownerUserId, runId, transcript as unknown as AgentTranscriptEntry[]);
}

export async function advanceAgentRun(input: AdvanceAgentRunInput): Promise<AdvanceAgentRunResult> {
  const { db, ownerUserId, threadId } = input;
  let run = db.updateAgentRun(ownerUserId, input.runId, { status: "running", error: null });
  const transcript = loadTranscript(db, ownerUserId, run.id);
  const provider = await input.provider();

  while (run.step < run.maxSteps) {
    const step = run.step + 1;
    let reply: Awaited<ReturnType<AgentModel["complete"]>>;
    try {
      reply = await provider.model.complete({
        messages: [
          { role: "system", content: provider.systemPrompt },
          ...input.history,
          ...transcript,
        ],
        tools: input.registry.definitions(),
      });
    } catch (error) {
      const failure = describeAgentFailure(error);
      db.updateAgentRun(ownerUserId, run.id, { status: "needs_attention", step, error: failure.message });
      throw toAgentFailureError(error);
    }

    const calls = reply.toolCalls ?? [];
    run = db.updateAgentRun(ownerUserId, run.id, { step });
    if (!calls.length) {
      const text = reply.content?.trim();
      if (!text) {
        const failed = db.updateAgentRun(ownerUserId, run.id, { status: "needs_attention", error: "模型没有返回可用内容。" });
        return { run: failed };
      }
      db.addAgentThreadMessage(ownerUserId, threadId, "assistant", text);
      run = db.updateAgentRun(ownerUserId, run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      // transcript 只是运行期中间态：终态后释放，审计由 tool_calls + receipts 承担。
      saveTranscript(db, ownerUserId, run.id, []);
      return { run };
    }

    // 只处理第一个动作；其余并行调用作为模型反馈记录，不进入 transcript。
    const [call, ...extras] = calls;
    transcript.push({ role: "assistant", content: reply.content ?? "", toolCalls: [call] });
    saveTranscript(db, ownerUserId, run.id, transcript);

    const outcome = await dispatchAction({ ...input, run, call, transcript });
    saveTranscript(db, ownerUserId, run.id, transcript);
    if (outcome.pendingToolCall) {
      const waiting = db.updateAgentRun(ownerUserId, run.id, { status: "waiting_approval" });
      return { run: waiting, pendingToolCall: outcome.pendingToolCall };
    }
    if (outcome.uncertain) {
      // 结果不确定时停在 uncertain：禁止盲目重试写操作，必须先核查。
      const halted = db.updateAgentRun(ownerUserId, run.id, { status: "uncertain", error: outcome.content });
      return { run: halted };
    }
    if (extras.length) {
      transcript[transcript.length - 1] = {
        role: "tool",
        toolCallId: call.id,
        content: `${outcome.content}\n（同一轮只处理一个动作；另有 ${extras.length} 个并行动作未执行，请逐个重新提出。）`,
      };
      saveTranscript(db, ownerUserId, run.id, transcript);
    }
    run = db.getAgentRun(ownerUserId, run.id) ?? run;
    if (run.status === "needs_attention") return { run };
  }

  const exhausted = db.updateAgentRun(ownerUserId, run.id, {
    status: "needs_attention",
    error: `本次运行达到最大步数 ${run.maxSteps}，请补充说明后继续。`,
  });
  return { run: exhausted };
}

type DispatchOutcome =
  | { pendingToolCall: AgentToolCallRecord; content?: undefined; uncertain?: undefined }
  | { pendingToolCall?: undefined; content: string; uncertain?: boolean };
async function dispatchAction(input: AdvanceAgentRunInput & {
  run: AgentRun;
  call: AgentToolCall;
  transcript: AgentModelMessage[];
}): Promise<DispatchOutcome> {
  const { db, ownerUserId, threadId, context, run } = input;
  const route = input.registry.findAction(input.call.name);
  const respond = (content: string): { content: string } => {
    input.transcript.push(toolResult(input.call.id, content));
    return { content };
  };
  if (!route) return respond(`未知工具：${input.call.name}。可用工具见系统说明。`);
  const invalid = route.action.validate?.(input.call.arguments);
  if (invalid) return respond(`参数无效：${invalid}`);

  let target;
  try {
    target = await route.action.target(input.call.arguments, context);
  } catch (error) {
    return respond(`动作未执行：${errorMessage(error)}`);
  }

  let summary = route.action.label;
  let diff: string | undefined;
  if (route.action.preview) {
    try {
      const preview = await route.action.preview(input.call.arguments, context);
      summary = preview.summary;
      diff = preview.diff;
    } catch (error) {
      return respond(`动作未执行：${errorMessage(error)}`);
    }
  }

  const toolCall = db.insertAgentToolCall(ownerUserId, {
    runId: run.id,
    threadId,
    skillId: route.skill.id,
    toolName: input.call.name,
    arguments: input.call.arguments,
    status: "awaiting_approval",
    kind: route.action.kind,
    risk: target.risk,
    idempotencyKey: toolCallIdempotencyKey(run.id, input.call.id),
    accountKey: target.accountKey,
    targetKey: target.targetKey,
    summary,
    ...(diff ? { diff } : {}),
  });

  const decision = evaluatePermission({
    kind: route.action.kind,
    target,
    grants: db.listAgentPermissionGrants(ownerUserId, threadId),
    toolCallId: toolCall.id,
  });
  if (decision.requiresApproval) {
    return { pendingToolCall: toolCall };
  }

  const executed = await input.executor.execute({
    ownerUserId,
    threadId,
    runId: run.id,
    action: route.action,
    args: input.call.arguments,
    target,
    context,
    toolCall,
  });
  const outcome = respond(executed.content);
  return executed.receipt.status === "uncertain" ? { ...outcome, uncertain: true } : outcome;
}
