import type { AgentInputRequest, AgentQuestion } from "../../shared/contracts.js";
import { clampRetryAfterSeconds, parseRetryAfterSeconds } from "../../shared/retry-after.js";
import { AgentSnapshotManager, type TurnToken } from "./core-snapshot.js";
import { cleanList, parseQuestions, validateSchema } from "./core-validation.js";
import { isCacheableReadQuery, readQueryCacheKey, ReadQueryCache } from "./read-query-cache.js";
import type { AgentCoreDependencies, AgentTool, AgentToolCall } from "./types.js";

export type CallOutcome = "continue" | "waiting" | "stale";

/** 失败信息回传模型，供其判断是否再自调用一次。 */
export function formatToolFailureForModel(name: string, message: string): string {
  return `工具失败：${message}\n工具：${name}\n请根据上述错误判断是否再自行调用一次；同一工具同一参数最多再试一次，仍失败请换策略或 ask_user。`;
}

function actionName(call: AgentToolCall): string {
  return typeof call.name === "string" && call.name ? call.name : "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionId(question: AgentQuestion, pattern: RegExp): string | undefined {
  return question.options?.find((option) => pattern.test(option.label))?.id;
}

function defaultAnswerForQuestion(question: AgentQuestion): string | string[] | undefined {
  const label = question.label.replace(/\s+/g, "");
  if (/酒店/.test(label) && /候选|备选|选择|资源/.test(label) && question.options?.length) {
    const hotels = question.options.slice(0, 5).map((option) => option.id);
    if (hotels.length) return question.kind === "multiple" ? hotels : hotels[0];
  }
  if (/用车.*座位|座位数/.test(label)) {
    const fiveSeat = optionId(question, /(?:5\s*座|五座)/);
    if (fiveSeat) return question.kind === "multiple" ? [fiveSeat] : fiveSeat;
    if (question.kind === "text") return "5座";
  }
  if (/(?:出发城市)?交通方式|往返交通|大交通/.test(label)) {
    if (question.kind === "multiple") {
      const flight = optionId(question, /(?:飞机.*往返|往返.*飞机|机票)/);
      const train = optionId(question, /(?:火车.*往返|往返.*火车|高铁.*往返|往返.*高铁|火车票|高铁票)/);
      const answers = [flight, train].filter((value): value is string => Boolean(value));
      if (answers.length >= 2) return answers;
    }
    const roundTrip = optionId(question, /(?:飞机.*火车|火车.*飞机|机票.*火车票|火车票.*机票)/);
    if (roundTrip) return roundTrip;
  }
  return undefined;
}

function splitDefaultQuestions(questions: AgentQuestion[]) {
  const visible: AgentQuestion[] = [];
  const defaultAnswers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = defaultAnswerForQuestion(question);
    if (answer === undefined) visible.push(question);
    else defaultAnswers[question.id] = answer;
  }
  return { visible, defaultAnswers };
}

function normaliseQuestion(question: AgentQuestion): AgentQuestion {
  const label = question.label.replace(/\s+/g, "");
  if (question.kind === "single" && /酒店/.test(label) && /候选|备选|选择|资源/.test(label)) {
    return { ...question, kind: "multiple" };
  }
  return question;
}

export class AgentToolRunner {
  private readonly readQueryCache = new ReadQueryCache();

  constructor(
    private readonly deps: AgentCoreDependencies,
    private readonly snapshots: AgentSnapshotManager,
    private readonly now: () => Date,
    private readonly id: () => string,
  ) {}

  async execute(id: string, call: AgentToolCall, token: TurnToken): Promise<CallOutcome> {
    if (call.argumentError) {
      const snapshot = this.snapshots.load(id);
      this.snapshots.result(snapshot, call.id, `参数 JSON 无效：${call.argumentError}。请修正后重新调用。`,
        { malformedArguments: true }, token.runId);
      this.snapshots.save(snapshot);
      return "continue";
    }
    if (call.name === "ask_user") return this.askUser(id, call, token);
    if (call.name === "request_approval") return this.requestApproval(id, call, token);

    const tool = this.deps.tools.find((candidate) => candidate.name === call.name);
    const initial = this.snapshots.load(id);
    if (!tool) {
      this.snapshots.result(initial, call.id, `未知工具：${call.name}`, undefined, token.runId);
      this.snapshots.save(initial);
      return "continue";
    }
    const validationError = tool.validate?.(call.arguments) ?? validateSchema(tool.parameters, call.arguments);
    if (validationError) {
      this.snapshots.result(initial, call.id, `参数无效：${validationError}`, undefined, token.runId);
      this.snapshots.save(initial);
      return "continue";
    }

    if (isCacheableReadQuery(call.name) && token.runId) {
      const cacheKey = readQueryCacheKey({
        localProductId: id,
        runId: token.runId,
        name: call.name,
        arguments: call.arguments,
      });
      const cached = this.readQueryCache.get(cacheKey);
      if (cached) {
        this.snapshots.result(initial, call.id, `${cached}\n\n（复用本轮已查询结果，未重复请求）`, {
          cachedReadQuery: true,
        }, token.runId);
        this.snapshots.save(initial);
        const afterCache = this.snapshots.load(id);
        if (!this.snapshots.current(afterCache, token)) return "stale";
        return afterCache.run?.status === "running" ? "continue" : "waiting";
      }
    }

    const requiresApproval = tool.requiresApproval ?? !!tool.write;
    const identity = requiresApproval
      ? await this.deps.accountFor(id)
      : {
          accountKey: "",
          productVersion: await this.deps.productFingerprint?.(id) ?? "",
        };
    let snapshot = this.snapshots.load(id);
    if (!this.snapshots.current(snapshot, token)) return "stale";
    const approval = this.snapshots.validApproval(snapshot);
    const scope = typeof tool.approvalScope === "function"
      ? tool.approvalScope(call.arguments)
      : (tool.approvalScope ?? [tool.name]);
    if (requiresApproval && (!approval || approval.accountKey !== identity.accountKey
      || approval.productVersion !== identity.productVersion || approval.intentVersion !== snapshot.run?.intentVersion
      || !scope.every((item) => approval.scope.includes(item)))) {
      this.snapshots.blockedResult(snapshot, call.id,
        "此操作需要当前意图、产品版本和账号范围的有效授权。", "authorization_denied", undefined, token.runId);
      this.snapshots.save(snapshot);
      return "continue";
    }

    if (requiresApproval) {
      snapshot = this.snapshots.load(id);
      if (!this.snapshots.current(snapshot, token)) return "stale";
      this.snapshots.event(snapshot, "status", `已提交外部操作：${tool.name}`, {
        writeDispatch: true,
        toolCallId: call.id,
        name: tool.name,
        arguments: call.arguments,
      }, token.runId);
      this.snapshots.save(snapshot);
    }

    try {
      const output = await this.executeWithRetryAfterWait(id, tool, call, token, {
        localProductId: id, ...identity, approval,
      }, requiresApproval);
      snapshot = this.snapshots.load(id);
      this.snapshots.result(snapshot, call.id, output.content, {
        ...(output.data ?? {}),
        ...(tool.write ? { write: true, remoteWrite: requiresApproval } : {}),
        ...(output.uncertainWrite ? { uncertainWrite: true } : {}),
      }, token.runId);
      if (output.uncertainWrite) this.snapshots.markUncertain(snapshot, call.id, output.content);
      if (isCacheableReadQuery(call.name) && token.runId && !output.content.startsWith("工具失败：")) {
        this.readQueryCache.set(readQueryCacheKey({
          localProductId: id,
          runId: token.runId,
          name: call.name,
          arguments: call.arguments,
        }), output.content);
      }
      this.snapshots.save(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshot = this.snapshots.load(id);
      const failureContent = formatToolFailureForModel(call.name, message);
      if ((error as {authorizationDenied?: boolean}).authorizationDenied) {
        this.snapshots.blockedResult(snapshot, call.id, failureContent, "authorization_denied", {error:message}, token.runId);
      } else this.snapshots.result(snapshot, call.id, failureContent, { error: message, retryHint: "once" }, token.runId);
      if ((error as { uncertainWrite?: boolean }).uncertainWrite) {
        this.snapshots.markUncertain(snapshot, call.id, message);
      } else if (this.snapshots.failures(snapshot, call, message) >= 2 && snapshot.run?.id === token.runId) {
        this.snapshots.pause(snapshot, "相同工具和参数连续失败两次，已暂停。请调整后再继续。");
      }
      this.snapshots.save(snapshot);
    }
    const after = this.snapshots.load(id);
    if (!this.snapshots.current(after, token)) return "stale";
    return after.run?.status === "running" ? "continue" : "waiting";
  }

  /** 错误里带明确等待秒数时先挂起，到期后自动再执行一次。 */
  private async executeWithRetryAfterWait(
    id: string,
    tool: AgentTool,
    call: AgentToolCall,
    token: TurnToken,
    context: { localProductId: string; accountKey: string; productVersion: string; approval?: import("../../shared/contracts.js").AgentApproval },
    requiresApproval: boolean,
  ) {
    void requiresApproval;
    try {
      return await tool.execute(call.arguments, context);
    } catch (error) {
      if ((error as { authorizationDenied?: boolean }).authorizationDenied
        || (error as { uncertainWrite?: boolean }).uncertainWrite) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const seconds = parseRetryAfterSeconds(message);
      if (!seconds || !this.snapshots.current(this.snapshots.load(id), token)) throw error;
      const waitSeconds = clampRetryAfterSeconds(seconds);
      const snapshot = this.snapshots.load(id);
      this.snapshots.event(snapshot, "status", `工具「${actionName(call)}」需等待 ${waitSeconds} 秒后重试，程序已挂起等待…`, {
        status: snapshot.run?.status,
        waitSeconds,
        toolName: call.name,
        toolCallId: call.id,
      }, token.runId);
      this.snapshots.save(snapshot);
      await delay(waitSeconds * 1_000);
      if (!this.snapshots.current(this.snapshots.load(id), token)) throw error;
      return tool.execute(call.arguments, context);
    }
  }

  private async askUser(id: string, call: AgentToolCall, token: TurnToken): Promise<CallOutcome> {
    const snapshot = this.snapshots.load(id);
    const questions = parseQuestions(call.arguments.questions);
    if (!questions) {
      this.snapshots.result(snapshot, call.id, "问题格式无效。", undefined, token.runId);
      this.snapshots.save(snapshot);
      return "continue";
    }
    if (!this.snapshots.current(snapshot, token)) return "stale";
    const { visible, defaultAnswers } = splitDefaultQuestions(questions.map(normaliseQuestion));
    if (!visible.length) {
      this.snapshots.result(snapshot, call.id, JSON.stringify(defaultAnswers), { defaultAnswers }, token.runId);
      this.snapshots.event(snapshot, "status", "已采用系统默认：出发城市交通为飞机和火车往返，用车座位数为 5 座；酒店候选默认保留前 5 个。", {
        defaultAnswers,
        toolCallId: call.id,
      }, token.runId);
      this.snapshots.save(snapshot);
      return "continue";
    }
    const request: AgentInputRequest = {
      id: this.id(),
      questions: visible,
      createdAt: this.now().toISOString(),
      ...(Object.keys(defaultAnswers).length ? { defaultAnswers } : {}),
    };
    snapshot.pendingInput = request;
    this.snapshots.event(snapshot, "input_request", "需要用户补充信息", { toolCallId: call.id, request }, token.runId);
    this.snapshots.waiting(snapshot, "waiting_input");
    this.snapshots.save(snapshot);
    return "waiting";
  }

  private async requestApproval(id: string, call: AgentToolCall, token: TurnToken): Promise<CallOutcome> {
    let scope = cleanList(call.arguments.scope);
    const summary = typeof call.arguments.summary === "string" ? call.arguments.summary.trim() : "";
    if (!scope.length || !summary) {
      const snapshot = this.snapshots.load(id);
      this.snapshots.result(snapshot, call.id, "审批范围或说明无效。", undefined, token.runId);
      this.snapshots.save(snapshot);
      return "continue";
    }
    try {
      scope = cleanList(await this.deps.normalizeApprovalScope?.(id, scope) ?? scope);
      if (!scope.length) throw new Error("审批范围无效。");
    } catch (error) {
      const snapshot = this.snapshots.load(id);
      if (!this.snapshots.current(snapshot, token)) return "stale";
      const message = error instanceof Error ? error.message : String(error);
      this.snapshots.blockedResult(snapshot, call.id, `当前不能审批：${message}`, "approval_precondition", undefined, token.runId);
      this.snapshots.save(snapshot);
      return snapshot.run?.status === "running" ? "continue" : "waiting";
    }
    const precondition = await this.deps.approvalPrecondition?.(id, scope);
    let snapshot = this.snapshots.load(id);
    if (!this.snapshots.current(snapshot, token)) return "stale";
    if (precondition) {
      this.snapshots.blockedResult(snapshot, call.id, `当前不能审批：${precondition}`,
        "approval_precondition", undefined, token.runId);
      this.snapshots.save(snapshot);
      return snapshot.run?.status === "running" ? "continue" : "waiting";
    }
    const identity = await this.deps.accountFor(id);
    snapshot = this.snapshots.load(id);
    if (!this.snapshots.current(snapshot, token)) return "stale";
    this.snapshots.createApproval(snapshot, scope, summary, identity, call.id, token.runId);
    this.snapshots.save(snapshot);
    return "waiting";
  }
}
