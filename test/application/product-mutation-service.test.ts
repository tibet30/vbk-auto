import assert from "node:assert/strict";
import test from "node:test";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import type { ProductDetail, ProductSummary } from "../../src/shared/contracts.js";

function detail(product: Record<string, unknown>): ProductDetail {
  return {
    id: "p-1",
    productId: null,
    status: "planning",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    product: product as ProductDetail["product"],
    messages: [],
    researchTasks: [],
    automation: null,
    planning: null,
  };
}

test("AI patch 在提交时基于数据库最新产品，而不是请求开始时的旧快照", () => {
  let saved = detail({
    basicInfo: { subtitle: "旧副标题", operationNotes: "运营刚刚手工补充" },
  });
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) => {
      saved = { ...saved, product: product as ProductDetail["product"], status: status ?? saved.status };
    },
  };
  const service = new ProductMutationService(store);

  const result = service.applyAiPatch("p-1", [
    { op: "replace", path: "/basicInfo/subtitle", value: "AI 新副标题" },
  ]);

  assert.equal(result.applied, true);
  assert.equal((saved.product.basicInfo as Record<string, unknown>).subtitle, "AI 新副标题");
  assert.equal((saved.product.basicInfo as Record<string, unknown>).operationNotes, "运营刚刚手工补充");
});

test("统一写入口锁定既有 meetingCity，AI 返回其它城市也不能覆盖", () => {
  let saved = detail({
    basicInfo: { meetingCity: "成都", destinationCity: "成都", province: "四川" },
  });
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) => {
      saved = { ...saved, product: product as ProductDetail["product"], status: status ?? saved.status };
    },
  };
  const service = new ProductMutationService(store);

  const result = service.applyAiPatch("p-1", [
    { op: "replace", path: "/basicInfo/destinationCity", value: "成都市" },
    { op: "replace", path: "/basicInfo/meetingCity", value: "西安市" },
  ]);

  assert.equal(result.applied, true);
  assert.equal((saved.product.basicInfo as any).meetingCity, "成都");
  assert.equal((saved.product.basicInfo as any).destinationCity, "成都");
});

test("统一写入口只在成功落库后广播最新 ProductDetail", () => {
  let saved = detail({ basicInfo: { subtitle: "旧值" } });
  const emitted: ProductDetail[] = [];
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) => {
      saved = { ...saved, product: product as ProductDetail["product"], status: status ?? saved.status };
    },
  };
  const service = new ProductMutationService(store, (product) => emitted.push(product));

  service.replace("p-1", { basicInfo: { subtitle: "新值" } }, { status: "review" });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], saved);
  assert.equal(saved.status, "review");
});

test("AI patch 写入待自动补图的 ctripLibrary cover 时不因缺 imageId/imageUrl 被拒", () => {
  let saved = detail({
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原2天1晚私家团",
      supplierProductCode: "AUTO-DRAFT",
      subtitle: "晋祠平遥核心景点轻松游",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "待自动补全封面图",
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠", poiName: "晋祠", poiId: 1 }], description: "游览晋祠", hotel: "当地3钻酒店", meals: "早餐自理；午餐自理；晚餐自理" },
      { day: 2, title: "平遥", spots: [{ name: "平遥古城", poiName: "平遥古城", poiId: 2 }], description: "游览平遥古城", hotel: "", meals: "早餐酒店；午餐自理；晚餐自理" },
    ],
  });
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) => {
      saved = { ...saved, product: product as ProductDetail["product"], status: status ?? saved.status };
    },
  };
  const service = new ProductMutationService(store);

  const result = service.applyAiPatch("p-1", [
    {
      op: "replace",
      path: "/presentation",
      value: {
        recommendationCategory: "优选行程",
        recommendation: "适合首次到访山西的轻松私家行程。",
        recommendations: [
          { category: "优选行程", text: "两天串联晋祠与平遥两大代表景点。" },
          { category: "缤纷景点", text: "历史古建与古城街巷体验兼顾。" },
          { category: "优质交通", text: "私家团用车更适合家庭与小团出行。" },
        ],
        features: "<p>精选山西代表景点，节奏轻松。</p>",
        cover: {
          source: "ctripLibrary",
          poi: "晋祠",
          description: "晋祠代表性古建横版封面",
          minQuality: 3,
        },
      },
    },
  ]);

  assert.equal(result.applied, true);
  assert.deepEqual((saved.product.presentation as Record<string, unknown>).cover, {
    source: "ctripLibrary",
    poi: "晋祠",
    description: "晋祠代表性古建横版封面",
    minQuality: 3,
  });
});
