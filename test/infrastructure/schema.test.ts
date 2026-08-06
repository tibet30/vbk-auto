import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseProduct } from "../../src/main/automation/schema/schema.js";
import {
  CheckpointStore,
  buildAutomationPlan,
  runResumableWorkflow,
} from "../../src/main/automation/workflow.js";

test("山西样例符合产品数据协议", async () => {
  const raw = await fs.readFile("examples/shanxi-4d3n.json", "utf8");
  const product = parseProduct(JSON.parse(raw));
  assert.equal(product.basicInfo.days, 4);
  assert.equal(product.itinerary.length, 4);
});

test("太原样例包含低 Token 自动录入所需配置", async () => {
  const raw = await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8");
  const product = parseProduct(JSON.parse(raw));
  assert.equal(product.presentation.cover.source, "ctripLibrary");
  assert.equal(product.operations.hotelTier, "当地3钻酒店/-3");
  assert.equal(product.operations.vehicleResource.resourceGroupId, 2206184);
  assert.equal(product.commercial.release.publicPriceCeiling, 3000);
  assert.doesNotMatch(product.itinerary[1].description, /灌肠/);
});

test("执行计划可只续跑行程且始终止步于草稿预检", async () => {
  const raw = await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8");
  const product = parseProduct(JSON.parse(raw));
  const plan = buildAutomationPlan(product, {
    productId: 76476655,
    from: "itinerary",
    through: "itinerary",
  });
  assert.deepEqual(plan.phases, ["itinerary"]);
  assert.equal(plan.safety.draftOnly, true);
  assert.equal(plan.safety.pricingAndInventory, true);
});

test("断点续跑跳过已完成阶段", async () => {
  const raw = await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8");
  const product = parseProduct(JSON.parse(raw));
  const state = { productId: "1", completed: {}, failures: [] };
  const store = {
    file: "/tmp/in-memory-checkpoint.json",
    load: async () => structuredClone(state),
    complete: async (phase) => {
      state.completed[phase] = "done";
    },
    fail: async () => {},
  };
  const calls = [];
  const handlers = {
    basic: async () => calls.push("basic"),
    presentation: async () => calls.push("presentation"),
    itinerary: async () => calls.push("itinerary"),
  };
  await runResumableWorkflow({
    product,
    productId: 1,
    through: "itinerary",
    handlers,
    checkpointStore: store,
  });
  await runResumableWorkflow({
    product,
    productId: 1,
    through: "itinerary",
    handlers,
    checkpointStore: store,
  });
  assert.deepEqual(calls, ["basic", "presentation", "itinerary"]);
});

test("行程条目数必须等于行程天数", () => {
  assert.throws(() =>
    parseProduct({
      sales: { productType: "domesticShort", productForm: "groupTour" },
      basicInfo: {
        supplierProductName: "测试产品",
        supplierProductCode: "TEST-1",
        subtitle: "测试副标题",
        days: 2,
        nights: 1,
        meetingCity: "太原",
        destinationCity: "太原",
        province: "山西",
        operationNotes: "测试",
      },
      itinerary: [{ day: 1, title: "第一天" }],
    }),
  );
});
