import test from "node:test";
import assert from "node:assert/strict";
import type { PlannerRequest } from "../../src/shared/contracts-planning.js";
import {
  composePlanningSystemPrompt,
  composePlanningUserMessage,
  projectProductContext,
} from "../../src/main/planning/adapters/planning-prompt.js";

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
