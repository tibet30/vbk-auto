import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { findBestCtripLibraryImage, parseProduct } from "../src/main/automation/schema.js";
import {
  CheckpointStore,
  buildAutomationPlan,
  runResumableWorkflow,
} from "../src/main/automation/workflow.js";

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

test("酒店等级只接受 customHotels 中的 5钻、4钻、3钻", async () => {
  const raw = JSON.parse(await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8"));
  for (const hotelTier of ["当地5钻酒店/-38", "当地4钻酒店/-4", "当地3钻酒店/-3"]) {
    assert.equal(parseProduct({ ...raw, operations: { ...raw.operations, hotelTier } }).operations.hotelTier, hotelTier);
  }
  assert.throws(() => parseProduct({ ...raw, operations: { ...raw.operations, hotelTier: "当地2钻酒店/-5" } }));
  assert.throws(() => parseProduct({ ...raw, operations: { ...raw.operations, hotelTier: "当地5钻酒店/-5" } }));
});

test("携程图库封面按最低质量和横版分辨率选择最高质量图片", () => {
  const index = findBestCtripLibraryImage([
    { quality: "2.7-4.0", resolution: "800 * 1400" },
    { quality: "3.0-3.8", resolution: "1067 * 800" },
    { quality: "3.6-4.9", resolution: "3000 * 1999" },
    { quality: "3.2-3.9", resolution: "1200 * 900" },
  ], 3.5);

  assert.equal(index, 2);
});

test("携程图库没有同时满足最低质量和封面分辨率的图片时返回 -1", () => {
  assert.equal(findBestCtripLibraryImage([
    { quality: "3.6-4.9", resolution: "750 * 500" },
    { quality: "2.7-3.3", resolution: "1440 * 1074" },
    { quality: "3.5", resolution: "800 * 1280" },
  ], 3.5), -1);
});

test("携程图库选图 aspect:'any' 时允许竖版图片", () => {
  const index = findBestCtripLibraryImage([
    { quality: "3.0-3.8", resolution: "800 * 1400" },
    { quality: "3.6-4.9", resolution: "3000 * 1999" },
    { quality: "4.0-4.5", resolution: "1280 * 1400" },
  ], 3, "any");

  assert.equal(index, 2);
});

test("携程图库选图 aspect:'landscape' 时拒绝竖版(默认行为)", () => {
  assert.equal(findBestCtripLibraryImage([
    { quality: "4.0", resolution: "1280 * 1600" },
  ], 3, "landscape"), -1);
});

test("携程图库选图 aspect:'any' 时分辨率不达标仍被拒", () => {
  assert.equal(findBestCtripLibraryImage([
    { quality: "4.0", resolution: "100 * 100" },
  ], 3, "any"), -1);
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

test("阶段顺序与 VBK 页签一致：资源配置排在条款维护之前", async () => {
  const raw = await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8");
  const product = parseProduct(JSON.parse(raw));
  const plan = buildAutomationPlan(product, { productId: 76476655 });
  assert.deepEqual(plan.phases, [
    "basic",
    "presentation",
    "itinerary",
    "package",
    "pricingInventory",
    "hotelResource",
    "vehicleResource",
    "terms",
    "preflight",
  ]);
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
