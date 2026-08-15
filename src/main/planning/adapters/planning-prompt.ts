/**
 * 阶段级 planning prompt。
 *
 * 只把当前阶段真正需要的规则和产品上下文交给模型，避免无关约束互相干扰；
 * 系统字段、真实资源标识和联系人信息在进入 prompt / prompt log 前统一剔除。
 */

import type { PlannerRequest, PlanningStage } from "../../../shared/contracts-planning.js";
import { STAGE_ALLOWED_MODULES } from "../stage-contract.js";
import { PRODUCT_FEATURES_RICH_TEXT_GUIDE } from "../../domain/product/features-rich-text.js";

const RECOMMENDATION_CATEGORIES = "优选行程、服务保障、贴心赠送、精选酒店、缤纷景点、特色美食、度假首选、超值赠送、五星精选";

const STAGE_RULES: Record<Exclude<PlanningStage, "research" | "validation">, string> = {
  skeleton: `1. skeleton.value 只包含 hotelTier、pickupCity、transport、reusePickupForDropoff、mealsIncluded、vehicleResource。
2. vehicleResource 只包含 requestedDailyCost；按目的地/接送城市等级、约每日公里数和服务小时数估算包车日价，禁止按产品售价、毛利或起订人数倒推。不确定可填 null。
3. 禁止输出任何系统编码、资源 ID、供应商信息、管家或联系人信息。`,
  basicInfo: `1. 只提交 basicInfo 一个模块；value 必须完整包含 subtitle、province、operationNotes，且不得增加其他字段。
2. province 填省、自治区或直辖市名称，不能填目的地城市名；当前草稿已有非空 province 时原样保留。
3. subtitle 和 operationNotes 使用简洁中文；不得把未核查信息写成已确认事实。`,
  itinerary: `1. itinerary.value 的天数必须等于 basicInfo.days，每天至少一个 spot。
2. spots 必须是对象数组，每项完整包含 name、poiName、poiId；未通过接口核查时 poiName 和 poiId 均填 null，禁止猜测 ID。
3. 每个 spot.name 只写一个可独立检索的地点；“钟楼和鼓楼”等多个地点必须拆开，括号内只可保留同一地点的别名或入口说明。
4. 同一天的 spots 必须按实际游览顺序排列，并集中在同一城市或彼此相邻的片区；逐一检查相邻及前后 POI，禁止安排明显远距离、跨城折返或会触发“POI离群”的景点组合。
5. 远距离或跨城景点优先拆到不同日期；确需同日移动时，description 必须在对应景点之间明确写出航班、高铁或长途专车等交通衔接及合理时长，不能把远距离 POI 直接连续排列。`,
  presentation: `1. recommendationCategory 与 recommendations[].category 只能从以下值选择：${RECOMMENDATION_CATEGORIES}。
2. recommendations 恰好 3 条，category 互不重复。
3. recommendation 与 recommendations[].text 使用面向游客的中文产品文案，不得虚构已核查的资源事实。
4. ${PRODUCT_FEATURES_RICH_TEXT_GUIDE}`,
  commercial: `1. packageName.value 直接提交 JSON 字符串，禁止包成 {"packageName":"..."} 对象。
2. pricing.adult > 0，pricing.child >= 0；cost.adult 不可超过 adult。
3. inventory.startDate / endDate 使用 YYYY-MM-DD，且 startDate 不晚于 endDate。
4. terms 完整包含 inclusions、exclusions、bookingNotes、refundPolicy。
5. release 完整包含 publicPriceCeiling (>0) 与 publicAuditRetries (1..10)；禁止输出 submitReview 或 publishAfterApproval，产品保持草稿态。`,
};

const CONTEXT_SECTIONS: Record<PlanningStage, readonly string[]> = {
  skeleton: ["sales", "basicInfo", "operations"],
  basicInfo: ["basicInfo"],
  itinerary: ["basicInfo", "operations", "itinerary"],
  presentation: ["basicInfo", "itinerary", "presentation"],
  commercial: ["sales", "basicInfo", "operations", "itinerary", "presentation", "commercial"],
  research: [],
  validation: ["sales", "basicInfo", "operations", "itinerary", "presentation", "commercial"],
};

const FORBIDDEN_CONTEXT_KEYS = new Set([
  "supplierProductCode", "hotelResource", "vehicleId", "resourceId",
  "resourceGroupId", "resourceGroupName", "supplierCode", "providerId",
  "contactCardId", "butler", "bookingControls",
]);

function sanitiseContext(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitiseContext(item));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTEXT_KEYS.has(key)) continue;
    if (parentKey === "vehicleResource" && key !== "requestedDailyCost") continue;
    result[key] = sanitiseContext(child, key);
  }
  return result;
}

export function projectProductContext(stage: PlanningStage, product: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const section of CONTEXT_SECTIONS[stage]) {
    if (product[section] !== undefined) projected[section] = sanitiseContext(product[section], section);
  }
  return projected;
}

export function composePlanningSystemPrompt(stage: PlanningStage): string {
  if (stage === "research") {
    return `你是「三人同游」旅游产品运营助手。当前阶段：research。\n\nresearch tasks 由本地 deterministic 生成；不要返回模块或核查结果，只通过工具提交可选的一句话备注。`;
  }
  const allowed = STAGE_ALLOWED_MODULES[stage].join("、") || "无";
  const stageRules = stage === "validation"
    ? "本阶段不生成新模块；只按工具 schema 返回结果，不得改写产品草稿。"
    : STAGE_RULES[stage];
  return `你是「三人同游」旅游产品运营助手。当前阶段：${stage}。\n\n唯一任务：通过 submit_${stage}_module 工具提交结构化参数。工具 schema 是输出字段的唯一标准。\n本阶段允许的模块：${allowed}。禁止返回其他模块。\n\n通用规则：\n1. 只调用工具；不要输出 Markdown、解释文字或 RFC6902 patch（op/path/add/replace/remove）。\n2. value 必须满足工具 schema 且字段完整；不要增加 schema 未声明的字段。\n3. 不要返回顶级 question 或 researchTasks；缺失信息写入对应 module.reason。不得自行声明外部核查已经完成。\n\n本阶段规则：\n${stageRules}`;
}

export function composePlanningUserMessage(request: PlannerRequest): string {
  const { stage, context, previousError } = request;
  const lines = [
    "产品骨架（系统字段未提供，禁止在输出中补写）：",
    `- destination = ${context.skeleton.destination}`,
    `- days/nights = ${context.skeleton.days}/${context.skeleton.nights}`,
    `- productForm = ${context.skeleton.productForm}`,
    `- productType = ${context.skeleton.productType}`,
    "",
    `当前阶段：${stage}`,
  ];
  if (context.acceptedModules.length) {
    lines.push("", "已落地模块（不要重复生成）：");
    for (const module of context.acceptedModules) lines.push(`  - ${module.module}${module.writePath ? ` → ${module.writePath}` : ""}`);
  }
  if (previousError) {
    lines.push("", `上一轮失败原因：${previousError.message}（code=${previousError.code}）`, "请修正该问题并严格按本阶段工具 schema 重试。");
  }
  lines.push("", "当前产品草稿（仅保留本阶段所需的安全上下文）：", JSON.stringify(projectProductContext(stage, context.currentProduct)));
  return lines.join("\n");
}
