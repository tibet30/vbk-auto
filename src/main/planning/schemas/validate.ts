/**
 * 模块 value 校验 + research task 校验 + stage 校验：
 *   - validate：通用 zod safeParse → { ok, value/reason }；
 *   - validateModuleValue：按 PlanningModule 路由到对应 schema，packageName
 *     先 normalisePackageNameValue（去括号 / 去空格）；
 *   - validateResearchTaskProposal：除 schema 校验外，还防 "已确认 / 已解决 /
 *     已完成 / 已通过" 措辞；
 *   - parseStageOutput：先过 baseStageOutputSchema（reply / modules），再
 *     按 STAGE_ALLOWED_MODULES 白名单过滤 + 调 validateModuleValue；
 *     researchTasks 顶级字段已被移除，research 阶段不再接 AI 顶级 researchTasks。
 */

import { z } from "zod";
import { normalisePackageNameValue } from "../package-name.js";
import type { ModuleOutcome, PlanningModule, PlanningStage, PlanningStageOutput, ResearchTaskProposal } from "../../../shared/contracts-planning.js";
import { PLANNING_STAGES } from "../../../shared/contracts-planning.js";
import { STAGE_ALLOWED_MODULES } from "../stage-contract.js";
import {
  basicInfoModuleValueSchema,
  presentationModuleValueSchema,
  researchTaskProposalSchema,
} from "./basic.js";
import {
  inventoryModuleValueSchema,
  itineraryModuleValueSchema,
  operationsHotelTierUpdateSchema,
  packageNameModuleValueSchema,
  pricingModuleValueSchema,
  releaseModuleValueSchema,
  termsModuleValueSchema,
} from "./modules.js";

export function validate<T>(schema: z.ZodType<T>, value: unknown): { ok: true; value: T } | { ok: false; reason: string } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data };
}

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
      return validate(packageNameModuleValueSchema, normalisePackageNameValue(value));
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

const baseStageOutputSchema = z.object({
  reply: requiredText(),
  modules: z.array(z.object({
    module: requiredText(),
    status: z.enum(["missing", "proposed", "accepted", "rejected"]),
    reason: z.string().trim().optional(),
    writePath: z.string().startsWith("/").optional(),
    acceptedFields: z.array(z.string()).optional(),
    missingFields: z.array(z.string()).optional(),
    researchTasks: z.array(researchTaskProposalSchema).optional(),
    value: z.unknown().optional(),
  })),
}).strict();

function requiredText() {
  // Local alias to keep the schema declaration close to baseStageOutputSchema.
  return z.string().trim().min(1);
}

export function isPlanningStage(value: unknown): value is PlanningStage {
  return typeof value === "string" && (PLANNING_STAGES as readonly string[]).includes(value);
}