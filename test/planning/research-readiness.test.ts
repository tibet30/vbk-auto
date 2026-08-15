/**
 * research task / automation readiness 测试：
 *  - 旧商业 research task 在规划 / 草稿阶段不阻断 readiness；
 *  - 资源 research task 只有当前产品本地字段未满足时才阻断；
 *  - 单一 type=image research task 在 presentation.cover 完整时不再阻塞。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { automationBlockers } from "../../src/main/automation/schema/schema-functions.js";
import { hasCompleteCtripLibraryCover, isCoverResearchTaskSatisfiedByProduct } from "../../src/main/minimax/minimax.js";

test("未确认的 pricing / inventory research task 不再阻断规划 / 草稿 readiness", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
    },
    operations: {
      vehicleResource: { resourceGroupId: 1, resourceGroupName: "X" },
    },
  };
  const tasks = [
    { state: "researching", label: "核查价格 / 库存 / 起订", type: "vbk" },
    { state: "researching", label: "核查城市 / 景点 ID", type: "vbk" },
  ];
  const blockers = automationBlockers(product, { researchTasks: tasks });
  assert.ok(!blockers.some((b) => /价格核查|库存核查/.test(b.label)));
});

test("合法 hotelTier 使未确认酒店 research task 不再阻断", () => {
  const product = {
    operations: { hotelTier: "当地5钻酒店/-38" },
  };
  const tasks = [
    { state: "researching", label: "核查酒店资源", type: "vbk" },
  ];
  const blockers = automationBlockers(product, { researchTasks: tasks });
  assert.ok(!blockers.some((b) => /酒店资源/.test(b.label)));
});

test("缺失或非法 hotelTier 时未确认酒店 research task 仍可阻断", () => {
  const tasks = [
    { state: "researching", label: "核查酒店资源", type: "vbk" },
  ];
  assert.ok(automationBlockers({ operations: {} }, { researchTasks: tasks }).some((b) => /酒店资源/.test(b.label)));
  assert.ok(automationBlockers({ operations: { hotelTier: "当地9钻酒店/-9" } }, { researchTasks: tasks }).some((b) => /酒店资源/.test(b.label)));
});

test("所有 research task 已 confirmed 时不再产生相关 blocker", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
    },
    operations: {
      vehicleResource: { resourceGroupId: 1, resourceGroupName: "X" },
    },
  };
  const tasks = [
    { state: "confirmed", label: "核查价格", type: "vbk" },
    { state: "confirmed", label: "核查库存", type: "vbk" },
  ];
  const blockers = automationBlockers(product, { researchTasks: tasks });
  // release.submitReview / publishAfterApproval 仍可能成为 blocker；这里不出现「价格核查」「库存核查」。
  assert.ok(!blockers.some((b) => /价格核查|库存核查/.test(b.label)));
});

test("draft-only release 仍会阻断自动化", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      release: { submitReview: true, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
    operations: {
      vehicleResource: { resourceGroupId: 1, resourceGroupName: "X" },
    },
  };
  const blockers = automationBlockers(product, { researchTasks: [] });
  assert.ok(blockers.some((b) => /submitReview/.test(b.label)));
});

test("完整 ctripLibrary cover 配置使 image research task 不再阻塞", () => {
  const product = {
    presentation: {
      cover: { source: "ctripLibrary", poi: "晋祠", description: "横版", minQuality: 3 },
    },
  };
  const task = { type: "image", label: "获取产品封面图", state: "researching" };
  assert.equal(isCoverResearchTaskSatisfiedByProduct(task, product), true);
  assert.equal(hasCompleteCtripLibraryCover(product), true);
});
