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
} from "../../../shared/contracts-planning.js";
import { STAGE_ALLOWED_MODULES } from "../schemas.js";
import { buildStageToolSchema } from "../tool-schema.js";

/**
 * Adapter 不做 transport retry —— 一次失败直接交给 orchestrator 走 stage 层 retry。
 * 这里的常量仅作为 schema 校验失败的内部 type 表达，不再保留任何 retry 循环。
 */

export interface OpenAICompatibleAdapterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
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
  constructor(private readonly config: OpenAICompatibleAdapterConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs ?? 90_000,
      maxRetries: 0,
    });
  }

  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    const stage = request.stage;
    const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];
    const toolSchema = buildStageToolSchema(stage);
    const userMessage = composeUserMessage(request);
    // Adapter 单次传输尝试：transport 失败直接抛错，由 orchestrator 决定是否 stage retry。
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: [
        { role: "system", content: composeSystemPrompt(stage) },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_completion_tokens: 4096,
      tools: [toolSchema],
      tool_choice: { type: "function", function: { name: toolSchema.function.name } },
      ...(this.config.extraParams ?? {}),
    } as never);

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
    return convertToolArgsToStageOutput(stage, parsed, allowed);
  }
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

/**
 * 阶段级 system prompt：明确不允许 RFC6902、明确哪些字段是禁写、明确 release
 * draft-only、明确 research tasks 不能写「已确认」。
 *
 *  严格对齐 buildStageToolSchema 生成的 JSON schema：research 阶段不暴露 modules，
 *  question 字段已去除（并入 module.reason）；AI tool schema 与 prompt 必须同步。
 *
 *  这段 prompt 文本**不包含 provider / model 字样**，adapter 只透传。
 */
function composeSystemPrompt(stage: PlanningStage): string {
  if (stage === "research") {
    return `你是「三人同游」旅游产品运营助手。当前阶段：research。

research 阶段是本地 deterministic 生成；你不需要主动返回任何模块或 researchTasks。
本阶段可仅返回一句话备注（reply 可选 / nullable），主要用于说明临时建议。`;
  }
  return `你是「三人同游」旅游产品运营助手。当前阶段：${stage}。

只允许返回单个 JSON（无 Markdown、无解释文字），并通过 submit_${stage}_module 工具提交：
{
  "reply": "给运营的中文一句话（必填）",
  "modules": [
    { "module": "<allowed>", "status": "accepted|proposed|missing|rejected", "value": <完整对象/数组>, "reason": "<可为 null>" }
  ]
}

硬性规则：
1. 严禁返回 RFC6902 patch（op / path / replace / add / remove）。本系统只接受上述 JSON。
2. release 模块：publicPriceCeiling 必填 (>0)；submitReview / publishAfterApproval 写 true 也会被系统强制改写为 false（草稿默认安全）。注意：tool schema 中 release 已不再声明 submitReview / publishAfterApproval 字段，违反会导致整体拒收。
3. supplierProductCode / vehicleResource / hotelResource / vehicleId / resourceId / resourceGroupId / supplierCode / providerId / contactCardId / butler / bookingControls 全部禁写；含这些键的输出会被拒。
4. presentation.recommendations 恰好 3 条，category 互不重复。
5. itinerary 每天至少 1 个 spots；天数 = basicInfo.days。
6. pricing.adult > 0；cost.adult 不可超过 adult。
7. inventory.startDate / endDate 必须是 YYYY-MM-DD；startDate 不能晚于 endDate。
8. terms 必须含 inclusions / exclusions / bookingNotes / refundPolicy 四个字段。
9. basicInfo 阶段必须返回 subtitle、province、operationNotes；province 必须是省/自治区/直辖市，不能直接填写目的地城市名。已有 province 由本地保留。
10. 不要再返回顶级 question / researchTasks 字段：question 已合并到 module.reason；research tasks 由本地 deterministic 生成。AI 不能自行声明核查结果。`;
}

/**
 * 组装阶段 user message：含项目骨架、已落地模块、已有 research tasks、上轮失败原因、当前产品草稿。
 * 注意 supplierProductCode 在 prompt 中标注为「AI 不可修改」。
 */
function composeUserMessage(request: PlannerRequest): string {
  const { stage, context, previousError } = request;
  const lines: string[] = [];
  lines.push(`项目骨架：`);
  lines.push(`- destination = ${context.skeleton.destination}`);
  lines.push(`- days/nights = ${context.skeleton.days}/${context.skeleton.nights}`);
  lines.push(`- productForm = ${context.skeleton.productForm}`);
  lines.push(`- productType = ${context.skeleton.productType}`);
  lines.push(`- supplierProductCode = ${context.skeleton.supplierProductCode}（AI 不可修改）`);
  lines.push("");
  lines.push(`当前阶段：${stage}`);
  if (context.acceptedModules.length) {
    lines.push("");
    lines.push("已落地模块（不要重复生成）：");
    for (const m of context.acceptedModules) lines.push(`  - ${m.module}${m.writePath ? ` → ${m.writePath}` : ""}`);
  }
  if (context.existingResearchTasks.length) {
    lines.push("");
    lines.push("已有 research tasks（避免重复）：");
    for (const task of context.existingResearchTasks) lines.push(`  - [${task.type}] ${task.label}`);
  }
  if (previousError) {
    lines.push("");
    lines.push(`上一轮失败原因：${previousError.message}（code=${previousError.code}）`);
    lines.push("本轮重试：只返回本阶段模块结构化 JSON，不要返回 RFC6902 patch。");
  }
  lines.push("");
  lines.push("当前产品草稿（参考上下文）：");
  lines.push(JSON.stringify(context.currentProduct));
  return lines.join("\n");
}
