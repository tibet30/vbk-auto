/**
 * 阶段级结构化输出 schema。
 *
 *  每个阶段只允许这一种结构。AI 不能写 RFC6902 path；orchestrator 收到结构化
 *  输出后调用 write*() 把模块写到固定路径。任何 schema 校验失败都
 *  视为 invalid_model_output —— orchestrator 触发 bounded retry。
 */

import { z } from "zod";
import { HOTEL_TIER_VALUES } from "../../shared/hotel-tiers.js";
import { RECOMMENDATION_CATEGORIES } from "../automation/schema/schema-definitions.js";
import {
  PLANNING_STAGES,
  type PlanningStage,
  type PlanningStageOutput,
  type ModuleOutcome,
  type PlanningModule,
  type ResearchTaskProposal,
} from "../../shared/contracts-planning.js";

const requiredText = z.string().trim().min(1);
const RECOMMENDATION_CATEGORY_VALUES = [...RECOMMENDATION_CATEGORIES] as [string, ...string[]];
const basicInfoModuleValueSchema = z.object({
  subtitle: requiredText,
  province: requiredText,
  operationNotes: requiredText,
}).strict();

const researchTaskProposalSchema = z.object({
  label: requiredText,
  type: z.enum(["vbk", "web", "cost", "image"]),
  detail: z.string().trim().optional(),
}).strict();

/** presentation 模块：3 条互不重复的推荐理由 + 4 项必要字段。 */
const presentationModuleValueSchema = z.object({
  recommendationCategory: z.enum(RECOMMENDATION_CATEGORY_VALUES),
  recommendation: requiredText,
  recommendations: z.array(z.object({
    category: z.enum(RECOMMENDATION_CATEGORY_VALUES),
    text: requiredText,
  })).length(3),
  features: requiredText,
  cover: z.object({
    source: z.literal("ctripLibrary"),
    poi: requiredText,
    description: requiredText,
    minQuality: z.number().int().min(0).max(5),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.recommendations.forEach((entry, index) => {
    if (seen.has(entry.category)) {
      ctx.addIssue({ code: "custom", path: ["recommendations", index, "category"], message: "推荐理由 category 必须互不重复" });
    }
    seen.add(entry.category);
  });
});

const itineraryDaySchema = z.object({
  day: z.number().int().min(1),
  title: requiredText,
  spots: z.array(requiredText).min(1),
  description: requiredText,
  hotel: z.string().default(""),
  meals: requiredText,
  mealDescriptions: z.array(requiredText).length(3).optional(),
}).strict();

const itineraryModuleValueSchema = z.array(itineraryDaySchema).min(1);

/** pricing 模块：成人/儿童价 + 起订人数 + 成本（可选）。 */
const pricingModuleValueSchema = z.object({
  currency: z.literal("CNY").default("CNY"),
  adult: z.number().positive(),
  child: z.number().nonnegative(),
  minimumTravelers: z.number().int().positive(),
  cost: z.object({
    adult: z.number().nonnegative(),
    child: z.number().nonnegative(),
    singleSupplement: z.number().nonnegative().default(0),
    childBed: z.number().nonnegative().default(0),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cost && value.cost.adult > value.adult) {
    ctx.addIssue({ code: "custom", message: "成本价不得高于售卖价" });
  }
});

const inventoryModuleValueSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate 必须是 YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate 必须是 YYYY-MM-DD"),
  dailyQuota: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (new Date(value.startDate) > new Date(value.endDate)) {
    ctx.addIssue({ code: "custom", message: "库存开始日期不能晚于结束日期" });
  }
});

const termsModuleValueSchema = z.object({
  inclusions: requiredText,
  exclusions: requiredText,
  bookingNotes: requiredText,
  refundPolicy: requiredText,
}).strict();

/**
 * release 模块：默认值强制 draft-only（submitReview=false, publishAfterApproval=false）。
 * AI 即便传 true 也被丢弃；只有人工/VBK 显式标记才会切换到发布态。
 */
const releaseModuleValueSchema = z.object({
  submitReview: z.boolean().optional(),
  publishAfterApproval: z.boolean().optional(),
  publicPriceCeiling: z.number().positive(),
  publicAuditRetries: z.number().int().min(1).max(10).default(3),
}).strict();

const packageNameModuleValueSchema = z.string().trim().min(1);

const operationsHotelTierUpdateSchema = z.object({
  hotelTier: z.enum(HOTEL_TIER_VALUES).optional(),
  pickupCity: z.string().trim().min(1).optional(),
  transport: z.enum(["charter", "shared", "none"]).optional(),
  reusePickupForDropoff: z.boolean().optional(),
  mealsIncluded: z.boolean().optional(),
}).strict();

/**
 * 每个阶段的输出 schema：包含 reply / question + 模块数组。
 * 模块字段的值由各 module 的 schema 验证；不在白名单的 module 整体视为 rejected。
 */
const baseStageOutputSchema = z.object({
  reply: requiredText,
  modules: z.array(z.object({
    module: requiredText,
    status: z.enum(["missing", "proposed", "accepted", "rejected"]),
    reason: z.string().trim().optional(),
    writePath: z.string().startsWith("/").optional(),
    acceptedFields: z.array(z.string()).optional(),
    missingFields: z.array(z.string()).optional(),
    researchTasks: z.array(researchTaskProposalSchema).optional(),
    value: z.unknown().optional(),
  })),
}).strict();

// ──────────────────────────────────────────────────────────────────────────
// 阶段 → 允许产出的模块白名单
// ──────────────────────────────────────────────────────────────────────────
export const STAGE_ALLOWED_MODULES: Record<PlanningStage, readonly PlanningModule[]> = {
  skeleton: ["skeleton"],
  basicInfo: ["basicInfo"],
  itinerary: ["itinerary"],
  presentation: ["presentation"],
  commercial: ["packageName", "pricing", "inventory", "terms", "release"],
  research: ["researchTasks"],
  validation: [],
};

/**
 * 单个模块 value 的 schema 校验（provider-neutral）。
 */
export function validateModuleValue(module: PlanningModule, value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (module) {
    case "basicInfo":
      return validate(basicInfoModuleValueSchema, value);
    case "presentation":
      return validate(presentationModuleValueSchema, value);
    case "itinerary":
      return validate(itineraryModuleValueSchema, value);
    case "packageName":
      return validate(packageNameModuleValueSchema, value);
    case "pricing":
      return validate(pricingModuleValueSchema, value);
    case "inventory":
      return validate(inventoryModuleValueSchema, value);
    case "terms":
      return validate(termsModuleValueSchema, value);
    case "release":
      return validate(releaseModuleValueSchema, value);
    case "skeleton":
      return validate(operationsHotelTierUpdateSchema, value);
    case "researchTasks":
      // researchTasks 是一组提案，逐条 schema 校验在 orchestrator 完成。
      return { ok: true, value };
  }
}

function validate<T>(schema: z.ZodType<T>, value: unknown): { ok: true; value: T } | { ok: false; reason: string } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 校验原始结构化输出是否符合某个阶段。
 */
export function parseStageOutput(stage: PlanningStage, raw: unknown): { ok: true; output: PlanningStageOutput } | { ok: false; reason: string } {
  const parsed = baseStageOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ") };
  }
  const allowed = STAGE_ALLOWED_MODULES[stage] as readonly string[];
  const moduleOutcomes: ModuleOutcome[] = [];
  for (const entry of parsed.data.modules) {
    if (!allowed.includes(entry.module)) {
      moduleOutcomes.push({
        module: entry.module as PlanningModule,
        status: "rejected",
        reason: `${stage} 阶段不允许产出 ${entry.module} 模块`,
        writePath: entry.writePath,
        acceptedFields: entry.acceptedFields,
        missingFields: entry.missingFields,
      });
      continue;
    }
    if (entry.status === "accepted" || entry.status === "proposed") {
      if (entry.module === "researchTasks") continue; // 在 orchestrator 统一处理
      if (entry.value === undefined) {
        moduleOutcomes.push({
          module: entry.module as PlanningModule,
          status: "rejected",
          reason: "模块声明为接受但缺少 value",
          writePath: entry.writePath,
          acceptedFields: entry.acceptedFields,
          missingFields: entry.missingFields,
        });
        continue;
      }
      const validated = validateModuleValue(entry.module as PlanningModule, entry.value);
      if (!validated.ok) {
        moduleOutcomes.push({
          module: entry.module as PlanningModule,
          status: "rejected",
          reason: validated.reason,
          writePath: entry.writePath,
          acceptedFields: entry.acceptedFields,
          missingFields: entry.missingFields,
        });
        continue;
      }
      moduleOutcomes.push({
        module: entry.module as PlanningModule,
        status: "accepted",
        writePath: entry.writePath,
        acceptedFields: entry.acceptedFields,
        missingFields: entry.missingFields,
        researchTasks: entry.researchTasks,
      });
    } else {
      moduleOutcomes.push({
        module: entry.module as PlanningModule,
        status: entry.status,
        reason: entry.reason,
        writePath: entry.writePath,
        acceptedFields: entry.acceptedFields,
        missingFields: entry.missingFields,
        researchTasks: entry.researchTasks,
      });
    }
  }
  // research 阶段不再接收 AI 顶级 researchTasks 字段；本地 deterministic
  // 生成的研究任务仍然走 runtime.addResearchTask，与 AI 输出无关。
  return {
    ok: true,
    output: {
      reply: parsed.data.reply,
      modules: moduleOutcomes,
    },
  };
}

/**
 * AI 写模块的固定写入路径集合。这些路径是「产品 JSON 里允许被 AI 写入的
 * 子树根」。任何 path 不在该集合内 → 立刻拒绝。
 */
export const AI_WRITABLE_PATHS = {
  basicInfo: "/basicInfo",
  presentation: "/presentation",
  itinerary: "/itinerary",
  packageName: "/commercial/packageName",
  pricing: "/commercial/pricing",
  inventory: "/commercial/inventory",
  terms: "/commercial/terms",
  release: "/commercial/release",
  skeleton: "/operations",
  researchTasks: null, // research tasks 不写产品 JSON
} as const;

export type AiWritablePath = NonNullable<(typeof AI_WRITABLE_PATHS)[keyof typeof AI_WRITABLE_PATHS]>;

/**
 * 验证 researchTask 的字段是否符合现有规则：
 *  - label / type 必填；
 *  - 不能是「已解决」措辞，避免 AI 假装完成核查。
 */
export function validateResearchTaskProposal(task: ResearchTaskProposal): { ok: true; task: ResearchTaskProposal } | { ok: false; reason: string } {
  const parsed = researchTaskProposalSchema.safeParse(task);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  if (/(?:已确认|已解决|已完成|已通过)/.test(parsed.data.label)) {
    return { ok: false, reason: "research task 标签不能是「已确认 / 已解决 / 已完成」等措辞" };
  }
  return { ok: true, task: parsed.data };
}

/**
 * 生成 system prompt 时使用的「黑名单」描述。Adapter 不直接拼装 prompt；
 * 它从 orchestrator 接收 context，由 orchestrator 统一调用本函数生成
 * prompt 文本。这样保证 prompt / schema / validator 都不包含 provider 字样。
 */
export function buildSystemPrompt(args: {
  stage: PlanningStage;
  allowedModules: readonly PlanningModule[];
  writablePaths: Record<PlanningModule, string | null>;
  hasHistory: boolean;
}) {
  const moduleList = args.allowedModules.map((module) => {
    const path = args.writablePaths[module];
    const pathNote = path ? ` → 写入固定路径 ${path}` : " → 不写入产品 JSON（仅写入 research tasks）";
    return `  - ${module}${pathNote}`;
  }).join("\n");

  return `你是「三人同游」旅游产品运营助手。用户会给出一个新项目的目的地、天数、晚数与产品形态（私家团 / 跟团游）。你要按阶段为该项目生成**结构化 JSON 输出**，由本地系统写入产品草稿。

===== 当前阶段：${args.stage} =====
本阶段你**只能**产出下列模块（其他模块请勿返回）：
${moduleList}

===== 输出格式（严格 JSON，无 Markdown、无解释文字）=====
{
  "reply": "给运营的中文一句话",
  "modules": [
    { "module": "<模块名>", "status": "accepted|proposed|missing|rejected", "value": <完整对象/数组>, "reason": "<可选说明>" }
  ]
}

说明：
- reason 字段是 nullable 字符串（可以填 null）。模块为 accepted 时 reason 可为 null；missing / rejected 时给出原因。
- question / researchTasks 顶级字段已被移除——前者并入 module.reason；后者由本地 deterministic 生成，AI 不应自行声明核查结果。

===== 硬性规则 =====
1. 不允许返回 RFC6902 patch、不允许 path 数组、不允许 op / replace / add 等字段。本系统**绝不接受 JSON Patch**。
2. value 必须完整写出全部子字段，缺一不可。
3. release 模块：
   - publicPriceCeiling 必填（>0）
   - publicAuditRetries 1..10
   - submitReview / publishAfterApproval 即使你写 true，系统也会忽略并强制 false。这是「草稿态默认安全」规则，不可被覆盖。
4. presentation.recommendations 必须恰好 3 条，category 互不重复。
5. itinerary 每天至少 1 个 spots；mealDescriptions 恰好 3 条。
6. pricing.adult > 0；pricing.child >= 0；cost.adult 不可超过 adult。
7. inventory.startDate / endDate 必须是 YYYY-MM-DD；startDate 不能晚于 endDate。
8. terms 必须包含 inclusions / exclusions / bookingNotes / refundPolicy 四个字段。
9. operations 阶段仅允许 hotelTier / pickupCity / transport / reusePickupForDropoff / mealsIncluded；禁止写入 supplierProductCode、vehicleId、resourceId、resourceGroupId、supplierCode、providerId、contactCardId。
10. basicInfo 阶段必须生成 subtitle、province、operationNotes；province 必须是省/自治区/直辖市名称，不能把 meetingCity / destinationCity 城市名直接当作 province。已有非空 province 会被本地保留，不得覆盖。
11. AI 不能自行声明 research task 已完成；research tasks 由本地 deterministic 生成并走运营 / VBK 核查流程。
${args.hasHistory ? "11. 历史会话已附在 user 消息尾部；本轮回复以补齐缺失模块为目标，已成功模块不要重复。" : ""}`;
}

/**
 * 列出所有阶段 + 它们的固定写入路径，便于上面 buildSystemPrompt 复用。
 */
export function getWritablePaths() {
  return { ...AI_WRITABLE_PATHS };
}

export function isPlanningStage(value: unknown): value is PlanningStage {
  return typeof value === "string" && (PLANNING_STAGES as readonly string[]).includes(value);
}

// Tool schema lives in a separate file to keep schemas.ts under the size budget.
export { buildStageToolSchema } from "./tool-schema.js";
