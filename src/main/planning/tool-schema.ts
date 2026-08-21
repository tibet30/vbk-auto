/**
 * OpenAI-compatible tool_call schema for each planning stage.
 *
 *  Provider-neutral: schema 与 prompt / validator 都不依赖 provider / model 字样；
 *  仅在 adapter 把它与具体 transport 绑定。
 *
 *  本文件**不依赖** Zod：输出的就是合法 strict JSON schema 对象，可直接喂给
 *  OpenAI Chat Completions / Anthropic / MiniMax 等兼容接口。
 *
 *  strict mode 约束（OpenAI structured outputs）：
 *   - additionalProperties=false 必须在每个 object 节点上声明；
 *   - 声明在 properties 里的字段必须同时出现在 required（除非显式 nullable）；
 *   - 不再使用 module + value 配对的弱约束，改用 oneOf 把每个 module 与其专属
 *     value schema 绑死；packageName 不再能与 pricing-shape value 同时通过；
 *   - research 阶段是本地 deterministic，AI 不应被问到 researchTasks；该项
 *     从 AI tool schema 中完全移除，runtime.addResearchTask 仍是唯一写入路径。
 */

import type { PlanningStage, PlanningModule } from "../../shared/contracts-planning.js";
import { STAGE_ALLOWED_MODULES } from "./stage-contract.js";
import { VBK_RECOMMENDATION_CATEGORIES } from "../domain/product/recommendation-categories.js";

/**
 * 共享子 schema：把 reason 等可有可无的字段编码为 nullable（required 仍包含），
 * 这样 strict 模式下模型必须为每个 branch 提供 reason 字段（或显式 null）。
 * 这样做的好处：模型被迫给出拒绝 / missing 的「原因」，避免空 reason 的脏数据。
 */
const REASON_FIELD: Record<string, unknown> = {
  type: ["string", "null"],
  description: "状态原因（accepted 可为 null；missing / rejected 必填）",
};

const STATUS_FIELD: Record<string, unknown> = {
  type: "string",
  enum: ["accepted", "proposed", "missing", "rejected"],
};

/**
 * 模块 value 子 schema（每个 module 一个独立分支）；这些 schema 都遵守
 * strict：type=object 时 additionalProperties=false + required 全覆盖。
 */
function moduleValueJsonSchema(module: PlanningModule): Record<string, unknown> {
  switch (module) {
    case "basicInfo":
      return {
        type: "object", additionalProperties: false,
        required: ["subtitle", "province", "destinationCity", "meetingCity", "operationNotes"],
        properties: {
          subtitle: { type: "string", minLength: 1 },
          province: { type: ["string", "null"], minLength: 1 },
          destinationCity: { type: ["string", "null"], description: "标准目的地城市名称；第一阶段必须填写，不得填写 POI ID" },
          meetingCity: { type: ["string", "null"], description: "接送/集合城市名称；如与目的地城市相同则填写相同城市" },
          operationNotes: { type: "string", minLength: 1 },
        },
      };
    case "presentation":
      return {
        type: "object",
        additionalProperties: false,
        required: ["recommendationCategory", "recommendation", "recommendations", "features"],
        properties: {
          recommendationCategory: { type: "string", enum: [...VBK_RECOMMENDATION_CATEGORIES] },
          recommendation: { type: "string", minLength: 1 },
          recommendations: {
            type: "array", minItems: 3, maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["category", "text"],
              properties: { category: { type: "string", enum: [...VBK_RECOMMENDATION_CATEGORIES] }, text: { type: "string", minLength: 1 } },
            },
          },
          features: { type: "string", minLength: 1, description: "VBK 产品特色富文本 HTML 片段：3～5 个亮点；仅允许 p/strong/em/ul/ol/li/br 标签且不得含任何属性、Markdown、链接或图片。" },
        },
      };
    case "itinerary":
      return {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["day", "title", "spots", "description", "hotel", "meals"],
          properties: {
            day: { type: "number", minimum: 1 },
            title: { type: "string", minLength: 1 },
            spots: { type: "array", minItems: 1, description: "按实际游览顺序排列。每个 spot 只能是一个可独立检索的可游览地点；不得把钟楼和鼓楼、回民街·钟鼓楼广场等组合地点写进同一 spot，必须拆成多个 spot；机场、车站、码头、酒店、民宿、集合点、接送点等交通/住宿节点禁止写入 spots，只能写在 description。", items: { type: "object", additionalProperties: false, required: ["name", "poiName", "poiId"], properties: { name: { type: "string", minLength: 1, description: "单一可游览地点名称；括号内可写同一地点别名，不能包含多个地点或交通/住宿节点" }, poiName: { type: ["string", "null"] }, poiId: { type: ["number", "null"], minimum: 1 } } } },
            description: { type: "string", minLength: 1 },
            hotel: { type: "string" },
            meals: { type: "string", minLength: 1 },
          },
        },
      };
    case "packageName":
      return { type: "string", minLength: 1 };
    case "pricing":
      return {
        type: "object",
        additionalProperties: false,
        required: ["currency", "adult", "child"],
        properties: {
          currency: { type: "string", enum: ["CNY"] },
          adult: { type: "number", exclusiveMinimum: 0 },
          child: { type: "number", minimum: 0 },
          cost: {
            type: "object",
            additionalProperties: false,
            required: ["adult", "child", "singleSupplement", "childBed"],
            properties: {
              adult: { type: "number", minimum: 0 },
              child: { type: "number", minimum: 0 },
              singleSupplement: { type: "number", minimum: 0 },
              childBed: { type: "number", minimum: 0 },
            },
          },
        },
      };
    case "inventory":
      return {
        type: "object",
        additionalProperties: false,
        required: ["startDate", "endDate", "dailyQuota"],
        properties: {
          startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          dailyQuota: { type: "integer", minimum: 1 },
        },
      };
    case "terms":
      return {
        type: "object",
        additionalProperties: false,
        required: ["inclusions", "exclusions", "bookingNotes", "refundPolicy"],
        properties: {
          inclusions: { type: "string", minLength: 1 },
          exclusions: { type: "string", minLength: 1 },
          bookingNotes: { type: "string", minLength: 1 },
          refundPolicy: { type: "string", minLength: 1 },
        },
      };
    case "release":
      return {
        type: "object",
        additionalProperties: false,
        required: ["publicPriceCeiling", "publicAuditRetries"],
        properties: {
          publicPriceCeiling: { type: "number", exclusiveMinimum: 0 },
          publicAuditRetries: { type: "integer", minimum: 1, maximum: 10 },
        },
      };
    case "skeleton":
      return {
        type: "object",
        additionalProperties: false,
        required: ["hotelTier", "pickupCity", "transport", "reusePickupForDropoff", "mealsIncluded", "vehicleResource"],
        properties: {
          hotelTier: { type: "string" },
          pickupCity: { type: "string", minLength: 1 },
          transport: { type: "string", enum: ["charter", "shared", "none"] },
          reusePickupForDropoff: { type: "boolean" },
          mealsIncluded: { type: "boolean" },
          vehicleResource: {
            type: "object",
            additionalProperties: false,
            required: ["requestedTotalCost"],
            properties: {
              requestedTotalCost: { type: ["number", "null"], exclusiveMinimum: 0, description: "AI 估算整段行程的预计用车总成本：综合每天实际用车、跨区移动、接送和行程密度，仅供后续按总价查询 VBK 资源组；不要输出日均价，不要通过产品售价、成人价、毛利或起订人数倒推；不要填写任何资源组 ID 或供应商编码。" },
            },
          },
        },
      };
    case "researchTasks":
      // research 阶段是本地 deterministic 生成；AI schema 不应暴露 researchTasks。
      // 这里留一个 placeholder 让 switch exhaustive 编译通过；运行时不会进入。
      return { type: "array", items: { type: "object" } };
  }
}

/**
 * 模块专属 branch：每个分支强制 module 字段是 const，绑定到自己的 value schema。
 * 这样即使某个 stage 的 allowed 列表同时含 packageName 与 pricing，模型也
 * 无法把 packageName 配上 pricing-shape value（或反过来）。
 */
function moduleBranch(module: PlanningModule): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["module", "status", "value", "reason"],
    properties: {
      module: { type: "string", const: module },
      status: STATUS_FIELD,
      value: moduleValueJsonSchema(module),
      reason: REASON_FIELD,
    },
  };
}

/**
 * 给定一组允许 module，构建对应 oneOf branch 数组。
 * 单一 module 时直接返回该 branch，避免在 strict 模式下引入一层不必要的 oneOf。
 */
function modulesItemsSchema(allowed: readonly PlanningModule[]): Record<string, unknown> {
  const branches = allowed.map(moduleBranch);
  if (branches.length === 1) return branches[0];
  return { oneOf: branches };
}

/**
 * 生成阶段级 tool_call schema。
 *
 *  输出是一个完整 strict JSON schema，**不包含** Zod 对象、函数、或非法关键字；
 *  schema 内容随 `stage` 不同而切换（每个阶段允许的 module 列表不同）。
 *
 *  研究阶段（research）：不暴露 modules / value；这是本地 deterministic 阶段，
 *  AI tool schema 仅保留 reply 给模型留个接话空间（仍然 optional / nullable）。
 */
export function buildStageToolSchema(stage: PlanningStage): {
  type: "function";
  function: {
    name: string;
    description: string;
    strict: true;
    parameters: Record<string, unknown>;
  };
} {
  if (stage === "research") {
    return {
      type: "function",
      function: {
        name: `submit_${stage}_module`,
        description: `research 阶段由本地 deterministic 生成，AI 不应主动返回结构化产物。`,
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["reply"],
          properties: {
            reply: { type: ["string", "null"], description: "可选的回复文本（不强制模型产出）" },
          },
        },
      },
    };
  }
  const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];
  const moduleValue = modulesItemsSchema(allowed);
  return {
    type: "function",
    function: {
      name: `submit_${stage}_module`,
      description: `返回 ${stage} 阶段的模块结构化 JSON；本地系统会用此 JSON 写入产品草稿。`,
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["reply", "modules"],
        properties: {
          // reply 仍必填（null 不允许）；模型每次必须给出中文一句话，便于 UI
          // 把「无意义空回复」挡在 orchestrator 之前。question 字段已被移除：
          // 完整 module 信息已经在 modules[].reason 里，重复提问只会让模型偷懒。
          reply: { type: "string", minLength: 1, description: "给运营的中文一句话" },
          modules: {
            type: "array",
            description: "本阶段产出的模块列表",
            items: moduleValue,
          },
        },
      },
    },
  };
}
