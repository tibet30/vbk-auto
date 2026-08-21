import OpenAI from "openai";
import {
  PlannerError,
  type PlanningItineraryDayDraft,
  type PlanningItineraryRequest,
  type PlanningLocation,
  type PlanningLocationRequest,
  type PlanningSpotRecommendationRequest,
  type ThreeStagePlanningAi,
} from "../../../shared/contracts-planning.js";
import { logAIPrompt } from "../../ai/prompt-log.js";
import type { AIPromptEntry } from "../../ai/prompt-log.js";
import {
  normaliseTransportError,
  type ChatCompletionBody,
} from "./openai-compatible-transport.js";

export interface ThreeStageAiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
  extraParams?: Record<string, unknown>;
  timeoutMs?: number;
}

const spotTool = {
  type: "function" as const,
  function: {
    name: "submit_attraction_candidates",
    description: "提交可独立检索的真实景点名称候选。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["names"],
      properties: {
        names: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: { type: "string" },
        },
      },
    },
  },
};

const locationTool = {
  type: "function" as const,
  function: {
    name: "submit_standard_location",
    description: "把原始目的地结构化为中国标准省级行政区名称和目的地城市名称。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["province", "destinationCity"],
      properties: {
        province: { type: "string", minLength: 1 },
        destinationCity: { type: "string", minLength: 1 },
      },
    },
  },
};

const itineraryTool = {
  type: "function" as const,
  function: {
    name: "submit_verified_itinerary",
    description: "只用给定的真实 POI ID 编排逐日行程。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["days"],
      properties: {
        days: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["day", "title", "description", "poiIds", "meals", "mealDescriptions"],
            properties: {
              day: { type: "integer", minimum: 1 },
              title: { type: "string" },
              description: { type: "string" },
              poiIds: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } },
              meals: { type: "string" },
              mealDescriptions: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const vehicleCostTool = {
  type: "function" as const,
  function: {
    name: "submit_vehicle_total_cost",
    description: "提交私家团整段行程的预计用车总成本。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["requestedTotalCost"],
      properties: { requestedTotalCost: { type: "number", exclusiveMinimum: 0 } },
    },
  },
};

export class OpenAIThreeStagePlanningAi implements ThreeStagePlanningAi {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(private readonly config: ThreeStageAiConfig) {
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async structureLocation(request: PlanningLocationRequest): Promise<PlanningLocation> {
    const messages = [
      {
        role: "system" as const,
        content: [
          "你是中国旅游产品的目的地标准化助手。",
          "只把原始目的地转换为标准中国省级行政区名称和标准目的地城市名称。",
          "province 必须是省、自治区或直辖市的常用标准名称；destinationCity 必须是城市名称，不能填省名、景点名、机场、车站或 POI ID。",
          "两个字段都必须非空；无法判断时仍需根据失败原因修正，不得返回解释文字。",
        ].join("\n"),
      },
      { role: "user" as const, content: JSON.stringify(request) },
    ];
    const args = await this.callTool("ThreeStage.structureLocation", messages, locationTool);
    const province = text(args.province);
    const destinationCity = text(args.destinationCity);
    if (!province || !destinationCity) {
      throw new PlannerError("invalid_model_output", "AI 地点结构化结果缺少 province 或 destinationCity。");
    }
    return { province, destinationCity };
  }

  async recommendSpotNames(request: PlanningSpotRecommendationRequest): Promise<string[]> {
    const messages = [
      {
        role: "system" as const,
        content: [
          "你是中国目的地产品的景点候选规划员。只推荐真实、单一、可检索的景点名称。",
          "禁止酒店、车站、机场、码头、集合点、停车场、入口、售票处以及 A和B 组合名称。",
          "不要生成或猜测 POI ID。候选应覆盖代表性景点，并尽量分布在可合理串联的片区。",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify(request),
      },
    ];
    const args = await this.callTool("ThreeStage.recommendSpotNames", messages, spotTool);
    const names = Array.isArray(args.names) ? args.names : [];
    const unique = new Map<string, string>();
    for (const value of names) {
      const name = typeof value === "string" ? value.trim() : "";
      if (!name || isForbiddenCandidateName(name)) continue;
      const key = normaliseName(name);
      if (!key || request.excludedNames.some((entry) => normaliseName(entry) === key)) continue;
      unique.set(key, name);
    }
    if (unique.size === 0) throw new PlannerError("empty_model_output", "AI 未返回新的可检索景点名称。");
    return [...unique.values()].slice(0, request.targetCount);
  }

  async composeVerifiedItinerary(request: PlanningItineraryRequest): Promise<PlanningItineraryDayDraft[]> {
    const messages = [
      {
        role: "system" as const,
        content: [
          "你是中国目的地行程规划员。只能引用候选池中的 poiId，不得虚构景点。",
          "必须恰好覆盖产品天数，每天至少一个 POI，同一 POI 不得重复。",
          "同日只安排同城景点；优先把相同或相邻区县安排在同一天。",
          "跨日沿一个方向移动，禁止 A→B→A 折返。全日型景点可单独占一天。",
          "无需用完候选池；代表性、游览节奏和地址聚类优先。",
        ].join("\n"),
      },
      { role: "user" as const, content: JSON.stringify(request) },
    ];
    const args = await this.callTool("ThreeStage.composeVerifiedItinerary", messages, itineraryTool);
    if (!Array.isArray(args.days)) throw new PlannerError("invalid_model_output", "AI 行程缺少 days。 ");
    return args.days.map(parseItineraryDay);
  }

  async estimateVehicleTotalCost(request: {
    destination: string;
    province: string;
    city: string;
    days: number;
    itinerary: unknown[];
  }): Promise<number> {
    const messages = [
      {
        role: "system" as const,
        content: "你负责估算中国境内私家团整段行程的用车总成本。结合每天的用车安排、目的地、天数、跨区移动、接送和行程密度，只给出一个合理的人民币总成本正数，用于按总价匹配现有 VBK 车辆资源组；不要给区间、日均价或解释。",
      },
      { role: "user" as const, content: JSON.stringify(request) },
    ];
    const args = await this.callTool("ThreeStage.estimateVehicleTotalCost", messages, vehicleCostTool);
    const amount = Number(args.requestedTotalCost);
    if (!Number.isFinite(amount) || amount <= 0) throw new PlannerError("invalid_model_output", "AI 未返回有效的全程用车总成本。");
    return Math.round(amount);
  }

  private async callTool(
    entry: AIPromptEntry,
    messages: Array<{ role: "system" | "user"; content: string }>,
    tool: typeof locationTool | typeof spotTool | typeof itineraryTool | typeof vehicleCostTool,
  ): Promise<Record<string, unknown>> {
    logAIPrompt({
      entry,
      provider: this.config.provider ?? "openai-compatible",
      model: this.config.model,
      messages,
    });
    const response = await this.createCompletion({
      model: this.config.model,
      messages,
      temperature: 0.1,
      max_completion_tokens: 4096,
      tools: [tool],
      tool_choice: { type: "function", function: { name: tool.function.name } },
      ...(this.config.extraParams ?? {}),
    });
    const call = response.choices[0]?.message?.tool_calls?.find(
      (item) => "function" in item && item.function.name === tool.function.name,
    );
    if (!call || !("function" in call)) {
      throw new PlannerError("invalid_model_output", "模型未通过结构化工具返回结果。");
    }
    try {
      const parsed = JSON.parse(call.function.arguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
      return parsed as Record<string, unknown>;
    } catch {
      throw new PlannerError("invalid_model_output", "工具返回不是合法 JSON 对象。");
    }
  }

  private async createCompletion(body: ChatCompletionBody) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PlannerError("provider_timeout", `AI 规划响应超时（${this.timeoutMs}ms），请重试。`));
      }, this.timeoutMs);
    });
    const request = this.client.chat.completions.create(
      body as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      { signal: controller.signal },
    );
    request.catch(() => undefined);
    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      throw normaliseTransportError(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseItineraryDay(value: unknown): PlanningItineraryDayDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlannerError("invalid_model_output", "AI 返回了无效的行程日。 ");
  }
  const row = value as Record<string, unknown>;
  return {
    day: Number(row.day),
    title: String(row.title ?? "").trim(),
    description: String(row.description ?? "").trim(),
    poiIds: Array.isArray(row.poiIds) ? row.poiIds.map(Number) : [],
    meals: String(row.meals ?? "早餐自理；午餐自理；晚餐自理").trim(),
    mealDescriptions: Array.isArray(row.mealDescriptions) && row.mealDescriptions.length === 3
      ? row.mealDescriptions.map((item) => String(item)) as [string, string, string]
      : undefined,
  };
}

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[\s·•・—_()（）【】\[\]景区风景区旅游区]/g, "");
}

function isForbiddenCandidateName(value: string): boolean {
  return /酒店|宾馆|民宿|客栈|机场|车站|火车站|高铁站|码头|集合点|停车场|售票处|入口|游客中心|\s(?:和|与|及|、|\+)\s/.test(value)
    || /[、+&＋]|和.+(?:寺|山|馆|园|湖|沟|城|村)|与.+(?:寺|山|馆|园|湖|沟|城|村)/.test(value);
}
