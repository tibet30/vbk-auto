/**
 * 规划 completeness 校验。
 *
 *  validation 阶段不调用 AI；它从持久化产品 + runtime.loadAcceptedModules
 *  中读取已接受的模块清单，然后对照 REQUIRED_MODULES 判定 missing 模块。
 *
 *  与 orchestrator 中的 in-memory accumulator 不同：本文件只依赖持久化
 *  真相，所以重启 / 续跑都能拿到一致结果。
 */

import type { PlanningModule, ModuleOutcome, PlanningSkeleton } from "../../shared/contracts-planning.js";
import { REQUIRED_MODULES } from "../../shared/contracts-planning.js";
import { HOTEL_TIER_VALUES } from "../../shared/hotel-tiers.js";
import { RECOMMENDATION_CATEGORIES } from "../automation/schema/schema-definitions.js";

export interface ValidationResult {
  missing: ModuleOutcome[];
  accepted: ModuleOutcome[];
  /** 是否满足 completeness。 */
  complete: boolean;
}

const REQUIRED_FOR_COMPLETION: readonly PlanningModule[] = [
  "presentation",
  "itinerary",
  "packageName",
  "pricing",
  "inventory",
  "terms",
  "release",
];

/**
 * 校验产品规划 completeness：
 *  - 从持久化 accepted 模块列表读（runtime.loadAcceptedModules）；
 *  - 不允许的字段视为缺失；
 *  - 当所有 REQUIRED_FOR_COMPLETION 模块都被标记为 accepted → 完成。
 *
 *  该函数**不会**调用 AI，也不会修改状态；它只报告事实。
 */
export function validateCompleteness(args: {
  acceptedModules: readonly PlanningModule[];
  now?: string;
}): ValidationResult {
  const acceptedSet = new Set(args.acceptedModules);
  const accepted: ModuleOutcome[] = Array.from(acceptedSet).map((module) => ({
    module,
    status: "accepted",
    updatedAt: args.now ?? new Date().toISOString(),
  }));
  const missing: ModuleOutcome[] = REQUIRED_FOR_COMPLETION
    .filter((module) => !acceptedSet.has(module))
    .map((module) => ({
      module,
      status: "missing",
      reason: "validation: 必需模块未落地",
      updatedAt: args.now ?? new Date().toISOString(),
    }));
  return { accepted, missing, complete: missing.length === 0 };
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 把 unknown 安全转成 plain record（排除 null / 数组 / 原始类型）。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 把 unknown 安全转成数组（非数组返回 undefined），用于遍历校验。
 */
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Deep validate 模块内容。
 *  - itinerary：长度 = skeleton.days，days 是 1..n 顺序且唯一，每天都有必填字段；
 *  - presentation：恰好 3 条互不重复 recommendations，每条 category 命中白名单；
 *  - commercial：每个子字段（pricing / inventory / release / terms）结构合法；
 *  - skeleton：hotelTier 命中白名单，pickupCity / transport 必填。
 *
 *  返回一组缺失 / 不合法的模块清单；空数组代表全部模块内容合法。
 */
export function deepValidateModules(args: {
  skeleton: PlanningSkeleton;
  product: Record<string, unknown>;
  acceptedModules: readonly PlanningModule[];
  now?: string;
}): { invalid: ModuleOutcome[] } {
  const nowIso = args.now ?? new Date().toISOString();
  const invalid: ModuleOutcome[] = [];
  const acceptedSet = new Set(args.acceptedModules);

  // 「模块在 product 里存在」是 deep validation 的真实触发条件；acceptedSet
  // 只是「当前被认可为合法」的缓存。resume 路径下，运营 / 手工可能把曾经合法
  // 的 itinerary 改坏，acceptedSet 会因为 shallow detection 不同意而不再含
  // itinerary；但产品里 itinerary 数组仍在，必须仍然 deep-validate 以触发
  // rewind。这避免「非法产品长期处于 completed 状态」的回归。
  const productHasModule = (module: PlanningModule) => {
    switch (module) {
      case "itinerary": return asArray(args.product.itinerary) !== undefined;
      case "presentation": return asRecord(args.product.presentation) !== undefined;
      case "packageName":
      case "pricing":
      case "inventory":
      case "terms":
      case "release":
        return asRecord(args.product.commercial) !== undefined && asRecord((args.product.commercial as Record<string, unknown>)[module]) !== undefined;
      case "skeleton":
        return asRecord(args.product.operations) !== undefined;
      case "researchTasks":
        return false;
    }
  };

  if (acceptedSet.has("itinerary") || productHasModule("itinerary")) {
    const itinerary = asArray(args.product.itinerary) ?? [];
    const expectedDays = args.skeleton.days;
    const seenDays = new Set<number>();
    const reasons: string[] = [];
    if (itinerary.length !== expectedDays) reasons.push(`行程天数 ${itinerary.length} ≠ 骨架天数 ${expectedDays}`);
    let index = 0;
    for (const day of itinerary) {
      const record = asRecord(day);
      if (!record) { reasons.push(`第 ${index + 1} 天不是对象`); index += 1; continue; }
      const dayNum = Number(record.day);
      if (!Number.isInteger(dayNum) || dayNum < 1) reasons.push(`第 ${index + 1} 天 day 字段不合法：${String(record.day)}`);
      else {
        if (seenDays.has(dayNum)) reasons.push(`第 ${index + 1} 天 day=${dayNum} 重复`);
        seenDays.add(dayNum);
        if (dayNum !== index + 1) reasons.push(`第 ${index + 1} 天 day=${dayNum} 不是顺序递增`);
      }
      if (textValue(record.title).length === 0) reasons.push(`第 ${index + 1} 天 title 缺失`);
      const spots = asArray(record.spots);
      if (!spots || spots.length === 0) reasons.push(`第 ${index + 1} 天 spots 缺失`);
      if (textValue(record.description).length === 0) reasons.push(`第 ${index + 1} 天 description 缺失`);
      if (textValue(record.meals).length === 0) reasons.push(`第 ${index + 1} 天 meals 缺失`);
      index += 1;
    }
    if (reasons.length > 0) {
      invalid.push({ module: "itinerary", status: "rejected", reason: reasons.join("；"), });
    }
  }

  if (acceptedSet.has("presentation") || productHasModule("presentation")) {
    const presentation = asRecord(args.product.presentation);
    const reasons: string[] = [];
    if (!presentation) {
      reasons.push("presentation 不是对象");
    } else {
      const recommendations = asArray(presentation.recommendations);
      if (!recommendations) reasons.push("recommendations 缺失");
      else if (recommendations.length !== 3) reasons.push(`recommendations 长度 ${recommendations.length} ≠ 3`);
      else {
        const seen = new Set<string>();
        let valid = true;
        for (const entry of recommendations) {
          const record = asRecord(entry);
          const category = textValue(record?.category);
          if (!category) { reasons.push("recommendation.category 缺失"); valid = false; continue; }
          if (!(RECOMMENDATION_CATEGORIES as readonly string[]).includes(category)) {
            reasons.push(`recommendation.category=${category} 不在白名单`); valid = false;
          }
          if (seen.has(category)) { reasons.push(`recommendation.category=${category} 重复`); valid = false; }
          seen.add(category);
          if (textValue(record?.text).length === 0) { reasons.push("recommendation.text 缺失"); valid = false; }
        }
        if (!valid) { /* reasons already populated */ }
      }
      if (textValue(presentation.recommendation).length === 0) reasons.push("presentation.recommendation 缺失");
      if (textValue(presentation.features).length === 0) reasons.push("presentation.features 缺失");
      if (textValue(presentation.recommendationCategory).length === 0) reasons.push("presentation.recommendationCategory 缺失");
    }
    if (reasons.length > 0) {
      invalid.push({ module: "presentation", status: "rejected", reason: reasons.join("；"), });
    }
  }

  const commercial = asRecord(args.product.commercial);
  if (acceptedSet.has("packageName") || (productHasModule("packageName"))) {
    if (!commercial || textValue(commercial.packageName).length === 0) {
      invalid.push({ module: "packageName", status: "rejected", reason: "packageName 缺失", });
    }
  }
  if (acceptedSet.has("pricing") || productHasModule("pricing")) {
    const pricing = asRecord(commercial?.pricing);
    if (!pricing) {
      invalid.push({ module: "pricing", status: "rejected", reason: "pricing 缺失", });
    } else {
      const reasons: string[] = [];
      if (pricing.currency !== "CNY") reasons.push("pricing.currency 必须是 CNY");
      if (!(typeof pricing.adult === "number" && pricing.adult > 0)) reasons.push("pricing.adult 必须 > 0");
      if (!(typeof pricing.child === "number" && pricing.child >= 0)) reasons.push("pricing.child 必须 ≥ 0");
      if (!(Number.isInteger(pricing.minimumTravelers) && (pricing.minimumTravelers as number) > 0)) reasons.push("pricing.minimumTravelers 必须是正整数");
      const cost = asRecord(pricing.cost);
      if (cost && typeof cost.adult === "number" && typeof pricing.adult === "number" && cost.adult > pricing.adult) {
        reasons.push("pricing.cost.adult 不可高于 pricing.adult");
      }
      if (reasons.length > 0) invalid.push({ module: "pricing", status: "rejected", reason: reasons.join("；"), });
    }
  }
  if (acceptedSet.has("inventory") || productHasModule("inventory")) {
    const inventory = asRecord(commercial?.inventory);
    if (!inventory) {
      invalid.push({ module: "inventory", status: "rejected", reason: "inventory 缺失", });
    } else {
      const reasons: string[] = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue(inventory.startDate))) reasons.push("inventory.startDate 必须是 YYYY-MM-DD");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue(inventory.endDate))) reasons.push("inventory.endDate 必须是 YYYY-MM-DD");
      if (!Number.isInteger(inventory.dailyQuota) || (inventory.dailyQuota as number) < 1) reasons.push("inventory.dailyQuota 必须是正整数");
      if (/^\d{4}-\d{2}-\d{2}$/.test(textValue(inventory.startDate)) && /^\d{4}-\d{2}-\d{2}$/.test(textValue(inventory.endDate))
        && new Date(textValue(inventory.startDate)) > new Date(textValue(inventory.endDate))) {
        reasons.push("inventory.startDate 不可晚于 endDate");
      }
      if (reasons.length > 0) invalid.push({ module: "inventory", status: "rejected", reason: reasons.join("；"), });
    }
  }
  if (acceptedSet.has("terms") || productHasModule("terms")) {
    const terms = asRecord(commercial?.terms);
    if (!terms) {
      invalid.push({ module: "terms", status: "rejected", reason: "terms 缺失", });
    } else {
      const missing = ["inclusions", "exclusions", "bookingNotes", "refundPolicy"].filter((key) => textValue(terms[key]).length === 0);
      if (missing.length > 0) invalid.push({ module: "terms", status: "rejected", reason: `terms 缺字段：${missing.join("、")}`, });
    }
  }
  if (acceptedSet.has("release") || productHasModule("release")) {
    const release = asRecord(commercial?.release);
    if (!release) {
      invalid.push({ module: "release", status: "rejected", reason: "release 缺失", });
    } else {
      const reasons: string[] = [];
      if (!(typeof release.publicPriceCeiling === "number" && release.publicPriceCeiling > 0)) reasons.push("release.publicPriceCeiling 必须 > 0");
      // release.submitReview / publishAfterApproval：当前 schema 允许任意 boolean。
      // AI 自动写入路径仍由 stage-runner.sanitiseModuleValue 强制置 false，
      // 这里不再针对发布态单独发 invalid。
      if (reasons.length > 0) invalid.push({ module: "release", status: "rejected", reason: reasons.join("；"), });
    }
  }
  if (acceptedSet.has("skeleton") || productHasModule("skeleton")) {
    const operations = asRecord(args.product.operations);
    if (!operations) {
      invalid.push({ module: "skeleton", status: "rejected", reason: "operations 缺失", });
    } else {
      const reasons: string[] = [];
      if (!(HOTEL_TIER_VALUES as readonly string[]).includes(textValue(operations.hotelTier))) reasons.push("operations.hotelTier 不在白名单");
      if (textValue(operations.pickupCity).length === 0) reasons.push("operations.pickupCity 缺失");
      if (!["charter", "shared", "none"].includes(textValue(operations.transport))) reasons.push("operations.transport 不合法");
      if (reasons.length > 0) invalid.push({ module: "skeleton", status: "rejected", reason: reasons.join("；"), });
    }
  }
  return { invalid };
}

/**
 * 列出规范上需要的模块集合（仅作导出，复用于其它模块）。
 */
export function requiredModules(): readonly PlanningModule[] {
  return REQUIRED_MODULES;
}

/**
 * 一个「无效模块」映射到「负责生成该模块的阶段」。research 阶段的产物不
 * 走 deep validation，但预留 mapping 以便未来加上 research 重跑逻辑时直接
 * 使用。skeleton / itinerary / presentation / commercial 是 4 个真正可能
 * 被 rewound 的阶段。
 */
export const MODULE_TO_STAGE: Readonly<Record<PlanningModule, import("../../shared/contracts-planning.js").PlanningStage>> = {
  skeleton: "skeleton",
  itinerary: "itinerary",
  presentation: "presentation",
  packageName: "commercial",
  pricing: "commercial",
  inventory: "commercial",
  terms: "commercial",
  release: "commercial",
  researchTasks: "research",
};

/**
 * 给定一组 invalid 模块，找出 PLANNING_STAGES 中最早出现的负责阶段。
 * 返回 undefined 表示「没有需要 rewound 的阶段」（即 invalid 全部来自
 * 一个不属于任一阶段的模块——理论上不会发生）。
 */
export function earliestInvalidStage(
  invalid: ReadonlyArray<ModuleOutcome>,
  stageOrder: ReadonlyArray<import("../../shared/contracts-planning.js").PlanningStage>,
): import("../../shared/contracts-planning.js").PlanningStage | undefined {
  const stages = new Set<import("../../shared/contracts-planning.js").PlanningStage>();
  for (const m of invalid) {
    const stage = MODULE_TO_STAGE[m.module];
    if (stage) stages.add(stage);
  }
  return stageOrder.find((s) => stages.has(s));
}

/**
 * 重新计算一个 state：根据 invalid 模块把 earliestStage 及之后的阶段
 * 从 completedStages 中移除，并设置 currentStage = earliestStage、status
 * = "needs_user"。保留更早的、已经合法的 completedStages。
 *
 *  返回的对象是新的，不会原地修改 state。lastAssistantReply / lastModuleSummary
 * 不被清理，UI 仍可读「上一轮跑过哪些」。
 */
export function rewindForInvalid(args: {
  state: import("../../shared/contracts-planning.js").PlanningGenerationState;
  invalid: ReadonlyArray<ModuleOutcome>;
  stageOrder: ReadonlyArray<import("../../shared/contracts-planning.js").PlanningStage>;
}): import("../../shared/contracts-planning.js").PlanningGenerationState {
  const earliest = earliestInvalidStage(args.invalid, args.stageOrder);
  if (!earliest) return args.state;
  const earliestIdx = args.stageOrder.indexOf(earliest);
  if (earliestIdx < 0) return args.state;
  const validStages = args.state.completedStages.filter((s) => args.stageOrder.indexOf(s) < earliestIdx);
  const reasons = args.invalid.map((m) => m.module);
  const lastMissing = args.state.lastMissingSummary ?? [];
  return {
    ...args.state,
    status: "needs_user",
    currentStage: earliest,
    completedStages: validStages,
    lastMissingSummary: [...new Set([...lastMissing, ...reasons])],
  };
}