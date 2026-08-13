/**
 * 单阶段执行逻辑：从 planner 拿一次输出 → 校验 → 写入产品 / research tasks →
 * 把模块结果合并到 state 中。
 *
 *  Orchestrator 主循环负责状态推进；本文件负责单阶段的执行细节。
 */

import { PlannerError, type PlanningStage, type PlanningStageOutput, type PlanningGenerationState, type ModuleOutcome, type ResearchTaskProposal, type PlanningModule, type PlanningStageError } from "../../shared/contracts-planning.js";
import { AI_WRITABLE_PATHS, validateModuleValue, validateResearchTaskProposal } from "./schemas.js";
import { STAGE_ALLOWED_MODULES } from "./stage-contract.js";
import { normaliseHotelTier } from "../../shared/hotel-tiers.js";
import type { OrchestratorRuntime } from "./types.js";
import { isProvinceLevelName, normaliseProvinceName } from "./runtime.js";
import { findVbkCopyBadCase } from "./vbk-copy-policy.js";

export interface StageExecutionResult {
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: ResearchTaskProposal[];
  /** 至少有一个 accepted 模块 → 该阶段算成功。 */
  hasAccepted: boolean;
}

const BLACKLISTED_VALUE_KEYS = [
  "supplierProductCode",
  "vehicleResource",
  "hotelResource",
  "contactCardId",
  "providerId",
  "supplierCode",
  "vehicleId",
  "resourceId",
  "resourceGroupId",
  "resourceGroupName",
  "butler",
  "bookingControls",
] as const;

/** 扫描 value 树，禁止出现任何禁写键。 */
export function findBlacklistedKey(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findBlacklistedKey(item);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "vehicleResource") {
        if (!child || typeof child !== "object" || Array.isArray(child)) return key;
        const childKeys = Object.keys(child as Record<string, unknown>);
        if (childKeys.some((childKey) => childKey !== "requestedDailyCost")) return key;
        continue;
      }
      if ((BLACKLISTED_VALUE_KEYS as readonly string[]).includes(key)) return key;
      const hit = findBlacklistedKey(child);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * 校验模块 value 并注入本地安全默认值（draft-only release / 酒店档次归一化）。
 */
export function sanitiseModuleValue(
  module: PlanningModule,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const hit = findBlacklistedKey(value);
  if (hit) return { ok: false, reason: `AI 输出包含禁写字段 ${hit}` };
  const copyBadCase = findVbkCopyBadCase(value);
  if (copyBadCase) {
    return {
      ok: false,
      reason: `AI 输出 ${copyBadCase.path} 命中 VBK 文案黑名单「${copyBadCase.term}」：${copyBadCase.reason}；请改写为「${copyBadCase.alternatives.join("」或「")}」`,
    };
  }

  if (module === "release" && value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...(value as Record<string, unknown>), submitReview: false, publishAfterApproval: false };
  }
  if (module === "pricing" && value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...(value as Record<string, unknown>), minimumTravelers: 1 };
  }
  if (module === "skeleton" && value && typeof value === "object" && !Array.isArray(value)) {
    const v = { ...(value as Record<string, unknown>) };
    if (typeof v.hotelTier === "string") {
      const normalised = normaliseHotelTier(v.hotelTier);
      v.hotelTier = normalised ?? "当地3钻酒店/-3";
    }
    value = v;
  }

  const validated = validateModuleValue(module, value);
  if (!validated.ok) return validated;
  return { ok: true, value: validated.value };
}

/**
 * 把一次 Planner 输出落盘到产品 / research tasks。
 *
 *  入参 `output.modules` 里的每个 outcome 都要经过：
 *    - stage 白名单校验；
 *    - value 黑名单 + 本地 schema 校验；
 *    - writeModule 落盘（researchTasks 走 addResearchTask）。
 *
 *  返回 accepted / rejected / researchTasks / hasAccepted。
 */
export async function executeStageOutput(args: {
  stage: PlanningStage;
  output: PlanningStageOutput;
  runtime: OrchestratorRuntime;
  localProductId: string;
}): Promise<StageExecutionResult> {
  const { stage, output, runtime, localProductId } = args;
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];

  // research tasks 是 module 列表里的一种 module（researchTasks）；adapter
  // 已经把 tool_call 顶级 researchTasks 合并进 modules，这里不再单独处理。

  for (const outcome of output.modules) {
    if (!allowed.includes(outcome.module)) {
      rejected.push({ module: outcome.module, status: "rejected", reason: `${stage} 阶段不允许产出 ${outcome.module} 模块` });
      continue;
    }
    if (outcome.status === "rejected") {
      rejected.push({ ...outcome, status: "rejected" });
      continue;
    }
    if (outcome.status === "missing") {
      rejected.push({ ...outcome, status: "missing" });
      continue;
    }

    if (outcome.module === "researchTasks") {
      for (const task of outcome.researchTasks ?? []) {
        const result = validateResearchTaskProposal(task);
        if (result.ok) {
          await runtime.addResearchTask(localProductId, result.task);
          researchTasks.push(result.task);
        } else {
          rejected.push({ module: "researchTasks", status: "rejected", reason: `${task.label}: ${result.reason}` });
        }
      }
      accepted.push({ ...outcome, status: "accepted" });
      continue;
    }

    const writePath = AI_WRITABLE_PATHS[outcome.module];
    if (!writePath) {
      rejected.push({ module: outcome.module, status: "rejected", reason: "模块未配置固定写入路径" });
      continue;
    }

    // value 是从原始 raw 中读取的；adapter 在拆 tool_call 时会把模块的 value 暴露到 outcome 里。
    const rawValue = outcome.value;
    const sanitised = sanitiseModuleValue(outcome.module, rawValue);
    if (!sanitised.ok) {
      rejected.push({ module: outcome.module, status: "rejected", reason: sanitised.reason });
      continue;
    }
    if (outcome.module === "basicInfo") {
      const current = await runtime.loadCurrentProduct(localProductId);
      const basic = current.basicInfo && typeof current.basicInfo === "object" && !Array.isArray(current.basicInfo)
        ? current.basicInfo as Record<string, unknown> : {};
      const next = { ...(sanitised.value as Record<string, unknown>) };
      const existingProvince = String(basic.province ?? "").trim();
      const province = normaliseProvinceName(String(next.province ?? "").trim() || existingProvince);
      const city = normaliseProvinceName(String(basic.meetingCity ?? basic.destinationCity ?? "").trim());
      const sameAsDestination = Boolean(city && province === city);
      const destinationIsProvince = isProvinceLevelName(city) && isProvinceLevelName(province);
      if (!province || (sameAsDestination && !destinationIsProvince)) {
        rejected.push({ module: "basicInfo", status: "rejected", reason: "basicInfo.province 缺失或不能直接使用目的地城市" });
        continue;
      }
      if (!String(next.province ?? "").trim() && existingProvince) delete next.province;
      sanitised.value = next;
    }
    const writeResult = await runtime.writeModule(localProductId, outcome.module, writePath, sanitised.value);
    if (!writeResult.ok) {
      rejected.push({ module: outcome.module, status: "rejected", reason: writeResult.reason || "本地写入失败" });
      continue;
    }
    accepted.push({ ...outcome, status: "accepted", writePath });
  }

  return { accepted, rejected, researchTasks, hasAccepted: accepted.length > 0 };
}

/**
 * 把一次 stage execution 的 accepted / rejected 列表落进 state。
 */
export function upsertStageInState(
  state: PlanningGenerationState,
  stage: PlanningStage,
  patch: { accepted: ModuleOutcome[]; rejected: ModuleOutcome[]; attempts: number; lastError?: PlanningStageError; updatedAt: string },
): PlanningGenerationState["stages"] {
  const others = state.stages.filter((s) => s.stage !== stage);
  return [
    ...others,
    {
      stage,
      accepted: patch.accepted.map((m) => ({
        module: m.module,
        status: "accepted" as const,
        writePath: m.writePath,
        acceptedFields: m.acceptedFields,
        missingFields: m.missingFields,
        updatedAt: patch.updatedAt,
      })),
      rejected: patch.rejected.map((m) => ({
        module: m.module,
        status: m.status,
        reason: m.reason,
        writePath: m.writePath,
        acceptedFields: m.acceptedFields,
        missingFields: m.missingFields,
        updatedAt: patch.updatedAt,
      })),
      attempts: patch.attempts,
      lastError: patch.lastError,
      updatedAt: patch.updatedAt,
    },
  ];
}

/**
 * 辅助：从 PlannerError 提取最后一条 PlanningStageError。
 */
export function toStageError(stage: PlanningStage, attempt: number, error: unknown): PlanningStageError {
  if (error instanceof PlannerError) {
    return { stage, attempt, code: error.code, message: error.message, details: error.details };
  }
  return { stage, attempt, code: "unknown", message: (error as { message?: string } | null)?.message ?? "未知错误" };
}
