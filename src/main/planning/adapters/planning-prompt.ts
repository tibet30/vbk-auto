/**
 * 阶段级 planning prompt。
 *
 * 只把当前阶段真正需要的规则和产品上下文交给模型，避免无关约束互相干扰；
 * 系统字段、真实资源标识和联系人信息在进入 prompt / prompt log 前统一剔除。
 */

import type { PlannerRequest, PlanningStage } from "../../../shared/contracts-planning.js";
import { STAGE_ALLOWED_MODULES } from "../stage-contract.js";
import { PRODUCT_FEATURES_RICH_TEXT_GUIDE } from "../../domain/product/features-rich-text.js";
import { VBK_RECOMMENDATION_CATEGORIES } from "../../domain/product/recommendation-categories.js";
import { resolveTravelScope } from "../runtime.js";

const RECOMMENDATION_CATEGORIES = VBK_RECOMMENDATION_CATEGORIES.join("、");

const STAGE_RULES: Record<Exclude<PlanningStage, "research" | "validation">, string> = {
  skeleton: `1. skeleton.value 只包含 hotelTier、pickupCity、transport、reusePickupForDropoff、mealsIncluded、vehicleResource。
2. vehicleResource 只包含 requestedTotalCost；按整段行程每天的实际用车、跨区移动、接送和行程密度估算全程总成本，禁止输出日均价，也禁止按产品售价、毛利或起订人数倒推。不确定可填 null。
3. 禁止输出任何系统编码、资源 ID、供应商信息、管家或联系人信息。`,
  basicInfo: `1. 只提交 basicInfo 一个模块；value 必须包含 subtitle、province、destinationCity、meetingCity、operationNotes；地点字段只输出名称，不输出或猜测任何 ID。
2. 中国目的地的 province 必须是标准省级行政区名称；境外目的地的 province 填国家、地区或一级行政区常用中文名称。destinationCity 必须是标准目的地城市名称，不能把景点名或 POI ID 填入其中，也不能把普通城市原样填进 province。第一阶段即使草稿已有原始目的地，也必须给出标准 province 和 destinationCity。
3. subtitle、meetingCity 和 operationNotes 使用简洁中文；不得把未核查信息写成已确认事实。`,
  itinerary: `1. itinerary.value 的天数必须等于 basicInfo.days，每天至少一个 spot。
2. 使用 POI-first 顺序：先围绕 travelScope 准备足量候选景点池，再从中选择最可能被 VBK/携程 POI 接口查到的单一可游览景点组织行程；不要先写跨区域大行程再补 POI。
3. spots 必须是对象数组，每项完整包含 name、poiName、poiId；未通过接口核查时 poiName 和 poiId 均填 null，禁止猜测 ID。本地系统会优先查接口，未命中时会要求替换为同范围可查景点。
4. 每个 spot.name 只写一个可独立检索的地点；“钟楼和鼓楼”等多个地点必须拆开，括号内只可保留同一地点的别名或入口说明。
5. 机场、车站、码头、酒店、民宿、集合点、接送点只能写进 description 的交通/接送说明，禁止写入 spots。
6. 如果 destination 是省、自治区或直辖市，默认只围绕系统指定的核心游览城市选点；需要第二个核心城市时，只能选择系统给出的近邻城市，禁止全省撒点。
7. 同一天的 spots 必须按实际游览顺序排列，并集中在同一城市或彼此相邻的片区；逐一检查相邻及前后 POI，禁止安排明显远距离、跨城折返或会触发“POI离群”的景点组合。
8. 远距离或跨城景点优先拆到不同日期；确需同日移动时，description 必须在对应景点之间明确写出航班、高铁或长途专车等交通衔接及合理时长，不能把远距离 POI 直接连续排列。`,
  presentation: `1. recommendationCategory 与 recommendations[].category 只能从以下值选择：${RECOMMENDATION_CATEGORIES}。
2. recommendations 恰好 3 条，category 互不重复。
3. recommendation 与 recommendations[].text 使用面向游客的中文产品文案，不得虚构已核查的资源事实。
4. ${PRODUCT_FEATURES_RICH_TEXT_GUIDE}`,
  commercial: `1. 套餐名由本地系统按目的地、天数、晚数和产品形态固定生成；本阶段不要输出 packageName。
2. pricing.adult > 0，pricing.child >= 0；cost.adult 不可超过 adult。
3. inventory.startDate / endDate 使用 YYYY-MM-DD，且 startDate 不晚于 endDate。
4. release 完整包含 publicPriceCeiling (>0) 与 publicAuditRetries (1..10)；禁止输出 submitReview 或 publishAfterApproval，产品保持草稿态。`,
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
    if (parentKey === "vehicleResource" && key !== "requestedTotalCost") continue;
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
  const travelScope = resolveTravelScope(context.skeleton.destination);
  const basicInfo = context.currentProduct.basicInfo && typeof context.currentProduct.basicInfo === "object" && !Array.isArray(context.currentProduct.basicInfo)
    ? context.currentProduct.basicInfo as Record<string, unknown>
    : {};
  const userIdea = typeof basicInfo.userIdea === "string" ? basicInfo.userIdea.trim() : "";
  const lines = [
    "产品骨架（系统字段未提供，禁止在输出中补写）：",
    `- destination = ${context.skeleton.destination}`,
    `- travelScope = ${travelScope.isProvinceLevel
      ? `省级输入，核心游览城市 ${travelScope.primaryCity}${travelScope.nearbyCoreCities.length ? `；可选近邻核心城市 ${travelScope.nearbyCoreCities.join("、")}` : "；不建议追加第二城市"}`
      : `城市/景区输入，围绕 ${travelScope.primaryCity} 游玩`}`,
    `- days/nights = ${context.skeleton.days}/${context.skeleton.nights}`,
    `- productForm = ${context.skeleton.productForm}`,
    `- productType = ${context.skeleton.productType}`,
    ...(userIdea ? ["", "用户初始想法（仅作为需求偏好参考，不代表已核查事实）：", userIdea] : []),
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
