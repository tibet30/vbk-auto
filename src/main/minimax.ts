import OpenAI, { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "openai";
import { z } from "zod";
import type { AiResponse } from "../shared/contracts.js";

const writablePatchPrefixes = [
  "/sales/productType", "/sales/productForm", "/sales/splitGroup",
  "/basicInfo/supplierProductName", "/basicInfo/subtitle", "/basicInfo/days", "/basicInfo/nights", "/basicInfo/meetingCity", "/basicInfo/destinationCity", "/basicInfo/province", "/basicInfo/operationNotes",
  "/presentation",
  "/operations/transport", "/operations/pickupCity", "/operations/reusePickupForDropoff", "/operations/hotelSource", "/operations/hotelTier", "/operations/mealsIncluded",
  "/commercial/packageName", "/commercial/terms",
  "/itinerary",
];

const writablePatchGuide = `可写 patch 路径只使用这些前缀：
- /sales/productType, /sales/productForm, /sales/splitGroup
- /basicInfo/supplierProductName, /basicInfo/subtitle, /basicInfo/days, /basicInfo/nights, /basicInfo/meetingCity, /basicInfo/destinationCity, /basicInfo/province, /basicInfo/operationNotes
- /presentation
- /operations/transport, /operations/pickupCity, /operations/reusePickupForDropoff, /operations/hotelSource, /operations/hotelTier, /operations/mealsIncluded
- /commercial/packageName, /commercial/terms
- /itinerary
不要写入 supplierProductCode、vehicleResource、pricing、inventory、release、城市 ID、资源 ID、供应商编码、车队价格、库存日期或成本。`;

const outputGuide = `只输出一个 JSON 对象，不能有 Markdown、解释文字或外层 data/result：
{"reply":"给运营看的简明中文回复","patch":[{"op":"add","path":"/presentation","value":{}}],"questions":[],"researchTasks":[{"label":"核查车辆资源","type":"vbk","detail":"在 VBK 资源库确认可用资源组、车型和供应商编码"}]}
字段要求：
- reply 必须是简明中文，可以概括已生成内容和待核查项。
- patch 必须是 RFC6902 数组；新增或整体覆盖字段时用 add 或 replace。
- questions 最多 1 条，只有真正阻塞第一版时才问。
- researchTasks 只列不能确认的数据，type 只能是 vbk/web/cost/image。`;

const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "patch", "questions", "researchTasks"],
  properties: {
    reply: { type: "string", minLength: 1 },
    patch: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "path"],
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          path: { type: "string", minLength: 1, pattern: "^/" },
          value: {},
        },
      },
    },
    questions: { type: "array", maxItems: 1, items: { type: "string" } },
    researchTasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "type"],
        properties: {
          label: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["vbk", "web", "cost", "image"] },
          detail: { type: "string" },
        },
      },
    },
  },
};

const responseTool = {
  type: "function",
  function: {
    name: "submit_product_update",
    description: "返回给 VBK Desktop 的产品协作回复、JSON Patch 和核查任务。",
    parameters: responseJsonSchema,
  },
};

const patchOperationSchema = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().startsWith("/"),
  value: z.unknown().optional(),
}).superRefine((operation, context) => {
  const writable = writablePatchPrefixes.some((prefix) => operation.path === prefix || operation.path.startsWith(`${prefix}/`));
  if (!writable) context.addIssue({ code: "custom", message: `不可写入产品字段：${operation.path}` });
});

const researchTaskSchema = z.object({ label: z.string(), type: z.enum(["vbk", "web", "cost", "image"]), detail: z.string().optional() });

export class MiniMaxServiceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const systemPrompt = `你是 VBK Desktop 的旅游产品运营助手。你的用户是携程 VBK 运营人员；他们会用极少信息创建一个可复用的通用旅游产品，例如“太原2天1晚私家团”。
当用户要求生成第一版时，基于已有目的地、天数、晚数和产品形态，生成完整且通用的产品文案、每日行程、基础信息与可审核的条款草稿。产品名称、行程、卖点可合理生成；不得虚构城市 ID、VBK 资源、车队价格、库存、门票、成本或已经完成的核查。上述运营数据缺失时，创建清晰、可由运营人员在 VBK 中执行的 researchTasks。
patch 必须是 RFC6902 风格，且只能修改产品草稿的非敏感字段。最多追问一个真正阻塞生成的问题；如果不阻塞，先给出第一版。

${writablePatchGuide}

${outputGuide}`;

function replyTimeout() {
  const parsed = Number(process.env.MINIMAX_REPLY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 90_000;
}

function miniMaxServiceTier() {
  return process.env.MINIMAX_SERVICE_TIER === "priority" ? "priority" : "standard";
}

function unwrapResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.reply === "string") return value;
  for (const key of ["data", "result", "response", "output"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const unwrapped = unwrapResponse(nested);
      if (unwrapped && typeof unwrapped === "object" && typeof (unwrapped as Record<string, unknown>).reply === "string") return unwrapped;
    }
  }
  return value;
}

function parseValue(value: unknown): AiResponse {
  const unwrapped = unwrapResponse(value);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  const record = unwrapped as Record<string, unknown>;
  const reply = typeof record.reply === "string" ? record.reply.trim() : "";
  if (!reply) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");

  const patch = Array.isArray(record.patch)
    ? record.patch.flatMap((operation) => {
      const parsed = patchOperationSchema.safeParse(operation);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  const questions = Array.isArray(record.questions)
    ? record.questions.filter((question): question is string => typeof question === "string" && Boolean(question.trim())).slice(0, 1)
    : typeof record.questions === "string" && record.questions.trim() ? [record.questions.trim()] : [];
  const researchTasks = Array.isArray(record.researchTasks)
    ? record.researchTasks.flatMap((task) => {
      const parsed = researchTaskSchema.safeParse(task);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  return { reply, patch, questions, researchTasks };
}

function parseJson(raw: string): AiResponse {
  const cleaned = raw.trim()
    .replace(/^<think>[\s\S]*?<\/think>\s*/i, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const json = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try { return parseValue(JSON.parse(json)); }
  catch { throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。"); }
}

function parseAssistantMessage(message: OpenAI.Chat.Completions.ChatCompletionMessage): AiResponse {
  const toolCall = message.tool_calls?.find((call) => "function" in call && call.function.name === "submit_product_update");
  if (toolCall && "function" in toolCall && toolCall.function.arguments) return parseJson(toolCall.function.arguments);
  if (!message.content) throw new MiniMaxServiceError("empty_model_output", "MiniMax 未返回内容。");
  return parseJson(message.content);
}

export class MiniMaxService {
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string }) {}

  private client(timeout: number) {
    // A planning turn must fail visibly instead of silently retrying for minutes.
    return new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, timeout, maxRetries: 0 });
  }

  async testConnection(): Promise<void> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "请先填写 MiniMax API Key。");
    const client = this.client(20_000);
    try {
      await client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
        extra_body: { thinking: { type: "disabled" } },
      } as never);
    } catch (error) { this.throwProviderError(error); }
  }

  async reply(input: { message: string; product: Record<string, unknown>; history: Array<{ role: string; content: string }> }): Promise<AiResponse> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "尚未配置 MiniMax API Key。");
    const client = this.client(replyTimeout());
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...input.history.slice(-12).map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
      { role: "user", content: `当前产品草稿：${JSON.stringify(input.product)}\n\n用户本轮输入：${input.message}\n\n请通过 submit_product_update 工具返回结构化结果。` },
    ];
    try {
      return parseAssistantMessage(await this.complete(client, messages));
    } catch (error) { this.throwProviderError(error); }
  }

  private async complete(client: OpenAI, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    const response = await client.chat.completions.create({
      model: this.config.model, messages, temperature: 0.3, max_completion_tokens: 4000,
      tools: [responseTool],
      tool_choice: { type: "function", function: { name: "submit_product_update" } },
      extra_body: { thinking: { type: "disabled" }, reasoning_split: true, service_tier: miniMaxServiceTier() },
    } as never);
    const message = response.choices[0]?.message;
    if (!message) throw new MiniMaxServiceError("empty_model_output", "MiniMax 未返回内容。");
    return message;
  }

  private throwProviderError(error: unknown): never {
    if (error instanceof MiniMaxServiceError) throw error;
    if (error instanceof AuthenticationError) throw new MiniMaxServiceError("provider_authentication", "MiniMax API Key 无效。");
    if (error instanceof RateLimitError) throw new MiniMaxServiceError("provider_rate_limit", "MiniMax 请求过于频繁，请稍后重试。");
    if (error instanceof APIConnectionTimeoutError) throw new MiniMaxServiceError("provider_timeout", "MiniMax 响应超时，请重试。");
    if (error instanceof APIConnectionError) throw new MiniMaxServiceError("provider_connection", "无法连接 MiniMax 服务。");
    throw new MiniMaxServiceError("provider_error", "MiniMax 服务暂时无法完成本次请求。");
  }
}
