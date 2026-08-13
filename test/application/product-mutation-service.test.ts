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
