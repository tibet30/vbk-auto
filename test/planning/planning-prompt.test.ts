import test from "node:test";
import assert from "node:assert/strict";
import type { PlannerRequest } from "../../src/shared/contracts-planning.js";
import {
  composePlanningSystemPrompt,
  composePlanningUserMessage,
  projectProductContext,
} from "../../src/main/planning/adapters/planning-prompt.js";
import { systemPrompt as legacySystemPrompt } from "../../src/main/minimax/minimax-constants.js";

const request: PlannerRequest = {
  stage: "basicInfo",
  context: {
    skeleton: {
      destination: "太原", days: 2, nights: 1, productForm: "privateTour",
      productType: "domesticShort", supplierProductCode: "VBK-SECRET-CODE",
    },
    acceptedModules: [],
    existingResearchTasks: [],
    history: [],
    transport: { providerLabel: "test", model: "test" },
    currentProduct: {
      sales: { productType: "domesticShort" },
      basicInfo: { supplierProductName: "太原2天1晚私家团", supplierProductCode: "VBK-SECRET-CODE", subtitle: "", province: "" },
      operations: {
        hotelTier: "当地5钻", bookingControls: { butler: { contactCardId: 1368298, providerId: 1279416 } },
        vehicleResource: { requestedDailyCost: 500, resourceGroupId: 2206275 },
      },
      commercial: { inventory: { startDate: "2026-08-13", endDate: "2027-08-13" } },
    },
  },
};

test("basicInfo prompt 只包含本阶段规则，不混入其他阶段约束", () => {
  const prompt = composePlanningSystemPrompt("basicInfo");
  assert.match(prompt, /subtitle、province、operationNotes/);
  assert.match(prompt, /省、自治区或直辖市/);
  assert.doesNotMatch(prompt, /publicPriceCeiling|recommendations 恰好|每天至少一个 spot|requestedDailyCost/);
});

test("basicInfo user message 不暴露系统编码、联系人、资源 ID 或无关阶段上下文", () => {
  const message = composePlanningUserMessage(request);
  assert.match(message, /destination = 太原/);
  assert.match(message, /supplierProductName/);
  assert.doesNotMatch(message, /VBK-SECRET-CODE|contactCardId|1368298|providerId|1279416|resourceGroupId|2206275/);
  assert.doesNotMatch(message, /bookingControls|commercial|operations|inventory/);
});

test("上下文投影递归清理禁写字段，并限制 vehicleResource 子字段", () => {
  const projected = projectProductContext("commercial", request.context.currentProduct);
  const text = JSON.stringify(projected);
  assert.match(text, /requestedDailyCost/);
  assert.doesNotMatch(text, /supplierProductCode|bookingControls|contactCardId|providerId|resourceGroupId/);
});

test("commercial prompt 保留商业阶段专属契约", () => {
  const prompt = composePlanningSystemPrompt("commercial");
  assert.match(prompt, /packageName\.value 直接提交 JSON 字符串/);
  assert.match(prompt, /publicPriceCeiling/);
  assert.doesNotMatch(prompt, /每个 spot\.name|recommendations 恰好/);
});

test("itinerary prompt 约束同日 POI 地理连续性和远距离交通衔接", () => {
  const prompt = composePlanningSystemPrompt("itinerary");
  assert.match(prompt, /同一城市或彼此相邻的片区/);
  assert.match(prompt, /逐一检查相邻及前后 POI/);
  assert.match(prompt, /禁止安排明显远距离、跨城折返或会触发“POI离群”的景点组合/);
  assert.match(prompt, /远距离或跨城景点优先拆到不同日期/);
  assert.match(prompt, /航班、高铁或长途专车等交通衔接及合理时长/);
  assert.match(legacySystemPrompt, /同一天的景点必须按实际游览顺序集中在同一城市或相邻片区/);
  assert.match(legacySystemPrompt, /禁止远距离、跨城折返或 POI 离群组合/);
});

test("presentation prompt 要求产品特色输出安全结构化富文本", () => {
  const prompt = composePlanningSystemPrompt("presentation");
  assert.match(prompt, /features 是 VBK 富文本字段/);
  assert.match(prompt, /<p><strong>短标题：<\/strong>具体说明<\/p>/);
  assert.match(prompt, /只允许 p、strong、em、ul、ol、li、br 标签/);
  assert.match(prompt, /禁止 Markdown/);
  assert.match(legacySystemPrompt, /features 是 VBK 富文本字段/);
  assert.match(legacySystemPrompt, /<p><strong>古建巡礼：<\/strong>/);
});
