/**
 * Provider-neutral OpenAI-compatible planning adapter.
 *
 *  这是规划子系统**唯一**允许出现 baseUrl / model / API key / provider 字样的
 *  adapter 实现；它不写 RFC6902，不调用老的 MiniMaxService.reply；它直接用
 *  OpenAI Chat Completions + tool_call 把每个阶段推给配置的 endpoint。
 *
 *  Provider-specific 思考/服务层级参数只能通过「transport capabilities」
 *  注入：adapter 构造时由调用方决定是否传 `extraParams`；prompt / schema /
 *  validator / orchestrator 永远不依赖这些参数。
 */

import OpenAI from "openai";
import {
  PlannerError,
  type Planner,
  type PlannerRequest,
  type PlanningStageOutput,
  type ModuleOutcome,
  type PlanningModule,
  type PlanningStage,
  type PoiNameResolutionRequest,
} from "../../../shared/contracts-planning.js";
import { logAIPrompt } from "../../ai/prompt-log.js";
import { logInfo } from "../../../shared/log-timestamp.js";
import { STAGE_ALLOWED_MODULES } from "../stage-contract.js";
import { buildStageToolSchema } from "../tool-schema.js";
import {
  type ChatCompletionBody,
  normaliseTransportError,
  planningTransportOptions,
} from "./openai-compatible-transport.js";
import { composePlanningSystemPrompt, composePlanningUserMessage } from "./planning-prompt.js";

/**
 * Adapter 不做 transport retry —— 一次失败直接交给 orchestrator 走 stage 层 retry。
 * 这里的常量仅作为 schema 校验失败的内部 type 表达，不再保留任何 retry 循环。
 */

// 透传 transport 工具，保持外部导入路径不变；
// planning-ipc / main / test 文件可以直接从本模块拉 transport helpers，不必关心具体子文件。
export { planningTransportOptions, normaliseTransportError, type ChatCompletionBody };

export interface OpenAICompatibleAdapterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 可选 provider 名称，仅用于日志（[AI prompt] provider 字段）。不会影响请求构造。
   */
  provider?: string;
  /**
   * 额外参数会原样合入每个 chat.completions.create 请求；典型用例：
   *  - MiniMax 系列的 `thinking: { type: "disabled" }`
   *  - DeepSeek/Evolink 的 service tier
   *  - 自部署推理服务的 `temperature` / `top_p`。
   * 这里**不**做参数验证，调用方负责拼装正确；adapter 自身不引入分支。
   */
  extraParams?: Record<string, unknown>;
  /** 单次请求超时（ms）。默认 90s。 */
  timeoutMs?: number;
}

export class OpenAICompatiblePlannerAdapter implements Planner {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  constructor(private readonly config: OpenAICompatibleAdapterConfig) {
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    const stage = request.stage;
    const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];
    const toolSchema = buildStageToolSchema(stage);
    const userMessage = composePlanningUserMessage(request);
    const messages = [
      { role: "system", content: composePlanningSystemPrompt(stage) },
      { role: "user", content: userMessage },
    ];
    // Adapter 单次传输尝试：transport 失败直接抛错，由 orchestrator 决定是否 stage retry。
    logAIPrompt({
      entry: "Planner.generateStage",
      provider: this.config.provider ?? "openai-compatible",
      model: this.config.model,
      messages,
    });
    const response = await this.createCompletion({
      model: this.config.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: 0.1,
      max_completion_tokens: 4096,
      tools: [toolSchema],
      tool_choice: { type: "function", function: { name: toolSchema.function.name } },
      ...(this.config.extraParams ?? {}),
    });

    const message = response.choices[0]?.message;
    if (!message) throw new PlannerError("empty_model_output", "模型未返回任何内容。");
    const toolCall = (message.tool_calls ?? []).find(
      (call) => "function" in call && call.function.name === toolSchema.function.name,
    );
    if (!toolCall || !("function" in toolCall)) {
      throw new PlannerError("invalid_model_output", "模型未通过结构化工具返回本阶段模块。");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new PlannerError("invalid_model_output", "工具返回不是合法 JSON。");
    }
    logInfo("[planning] adapter.result", JSON.stringify({ stage, parsed }));
    return convertToolArgsToStageOutput(stage, parsed, allowed);
  }

  async resolvePoiName(request: PoiNameResolutionRequest): Promise<string | null> {
    const messages = composePoiNameResolutionMessages(request);
    logAIPrompt({
      entry: "Planner.resolvePoiName",
      provider: this.config.provider ?? "openai-compatible",
      model: this.config.model,
      messages,
    });
    const response = await this.createCompletion({
      model: this.config.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: 0,
      max_completion_tokens: 128,
      tools: [poiNameToolSchema],
      tool_choice: { type: "function", function: { name: poiNameToolSchema.function.name } },
      ...(this.config.extraParams ?? {}),
    });
    const call = response.choices[0]?.message?.tool_calls?.find(
      (item) => "function" in item && item.function.name === poiNameToolSchema.function.name,
    );
    if (!call || !("function" in call)) return null;
    try {
      return parsePoiNameToolArgs(JSON.parse(call.function.arguments));
    } catch {
      return null;
    }
  }

  /**
   * SDK timeout 之外再加一层硬截止：即便兼容服务端保持连接却不返回 body，阶段也会
   * 在 timeoutMs 内释放，不会把一次新建产品挂十几分钟。
   *
   *  Promise.race 只消费第一个 settled 的 promise；超时触发后 SDK 抛
   *   APIUserAbortError，那条 rejection 必须就地 swallow，否则会在主进程
   *   触发 UnhandledPromiseRejection 警告；我们把它绑在硬截止发出的
   *   controller.abort() 之后立即吞掉。
   */
  private async createCompletion(body: ChatCompletionBody) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PlannerError("provider_timeout", `AI 规划响应超时（${this.timeoutMs}ms），请重试。`));
      }, this.timeoutMs);
    });
    // 在 race 之前先把 SDK promise 的 late-rejection 兜底掉；
    // 超时赢家是 hardTimeout，SDK 抛出的 APIUserAbortError 不再传到 race 外。
    const sdkPromise = this.client.chat.completions.create(body as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, { signal: controller.signal });
    sdkPromise.catch(() => undefined);
    try {
      return await Promise.race([sdkPromise, hardTimeout]);
    } catch (error) {
      throw normaliseTransportError(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** POI 名称替换的约束独立导出，防止 prompt 和契约测试漂移。 */
export function composePoiNameResolutionMessages(request: PoiNameResolutionRequest) {
  const retryRule = request.previousCandidates.length > 0
    ? `已尝试且未命中的候选：${request.previousCandidates.join("、")}。本次必须给出与以上所有候选不同的单一 POI 名称。`
    : "这是第一次候选替换。";
  return [
    {
      role: "system" as const,
      content: "你负责为未通过 VBK suggestPoi 查询的行程景点，给出一个同目的地/同核心游览城市内更可能被接口查到的可替代 POI 名称。只可输出一个真实、单一、适合替换原景点的可游览地点实体名称：不得给 POI ID、解释、详细街道地址、多个候选或组合点；不得输出机场、车站、码头、酒店、民宿、集合点等接送/交通/住宿节点。原名若含并列或组合景点，优先从中选择一个最具代表性的主景点；若原名本身不可查，可以换成同主题或同片区的可游览景点。无法安全判断时返回 null。",
    },
    {
      role: "user" as const,
      content: `目的地/游览范围：${request.destination}\n原行程名称：${request.originalName}\n该名称刚刚未能通过 VBK suggestPoi 查询。请给出可替换它、并最可能通过该接口查到的单一 POI 名称（第 ${request.attempt} 次尝试）。${retryRule}`,
    },
  ];
}

export const poiNameToolSchema = {
  type: "function" as const,
  function: {
    name: "submit_vbk_poi_name",
    description: "提交一个可替换未命中景点、并可再次用于 VBK suggestPoi 查询的单一可游览 POI 名称；不能是交通或住宿节点。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["poiName"],
      properties: { poiName: { type: ["string", "null"], description: "单一 POI 名称；不确定时 null" } },
    },
  },
};

export function parsePoiNameToolArgs(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const poiName = (value as { poiName?: unknown }).poiName;
  return typeof poiName === "string" ? poiName.trim() || null : null;
}

/**
 * 把 tool_call arguments 转成 PlanningStageOutput。
 *
 *  关键约束：模块 value 通过后由 orchestrator / stage-runner 进一步校验；
 *  adapter 在这里只做最粗的字段提取 + module/status 过滤，不写产品。
 */
export function convertToolArgsToStageOutput(
  stage: PlanningStage,
  raw: unknown,
  allowed: readonly PlanningModule[],
): PlanningStageOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlannerError("invalid_model_output", "工具返回不是对象。");
  }
  const record = raw as Record<string, unknown>;
  const reply = typeof record.reply === "string" && record.reply.trim() ? record.reply.trim() : "本轮模型返回完成。";
  // question 字段已被从 AI tool schema / prompt 中移除；保留对老模型的 defensive 解析。
  const question = typeof record.question === "string" && record.question.trim() ? record.question.trim() : undefined;
  const modules: ModuleOutcome[] = [];
  if (Array.isArray(record.modules)) {
    for (const entry of record.modules) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as { module?: string; status?: string; value?: unknown; reason?: string };
      if (typeof e.module !== "string" || !allowed.includes(e.module as PlanningModule)) {
        if (typeof e.module === "string") {
          modules.push({ module: e.module as PlanningModule, status: "rejected", reason: `${stage} 阶段不允许产出 ${e.module} 模块` });
        }
        continue;
      }
      const status = (e.status === "accepted" || e.status === "proposed" || e.status === "missing" || e.status === "rejected") ? e.status : "rejected";
      if (status === "missing" || status === "rejected") {
        modules.push({ module: e.module as PlanningModule, status, reason: typeof e.reason === "string" ? e.reason : undefined });
        continue;
      }
      modules.push({
        module: e.module as PlanningModule,
        status,
        reason: typeof e.reason === "string" ? e.reason : undefined,
        // 把 value 透传给 stage-runner 做 sanitise；adapter 不做 schema 校验。
        value: e.value,
      } as ModuleOutcome & { value?: unknown });
    }
  }
  return { reply, question, modules };
}
