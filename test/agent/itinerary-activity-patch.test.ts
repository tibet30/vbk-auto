import test from "node:test";
import assert from "node:assert/strict";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import { PRODUCT_PATCH_SCHEMA } from "../../src/main/agent/integration-patch-schema.js";
import { applyProductPatch } from "../../src/main/operations/product-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
const night = { time: "晚上", title: "俄博梁星空", detail: "按天气安排星空拍摄", type: "other" };
const detail = { product: { basicInfo: { days: 1 }, itinerary: [{ day: 1, title: "送站", spots: [], activities: [{ time: "上午", title: "送站", detail: "送站结束", type: "transport" }], description: "送站", hotel: "无", meals: "自理" }] }, messages: [] } as unknown as ProductDetail;
test("错误活动包装必须在写入前拒绝，保留已保存的活动和行程", () => {
  const before = JSON.stringify(detail);
  for (const activities of [{ item: night }, { item: [night] }, [[night]], [{ ...night, type: "night" }]]) {
    assert.throws(() => agentPatchOperations(detail, { itinerary: [{ day: 1, activities }] }), /activities.*活动数组/);
    assert.equal(JSON.stringify(detail), before);
  }
});
test("工具明确提供活动数组，正常夜拍补丁保存后回读仍保留夜间时间", () => {
  assert.equal(PRODUCT_PATCH_SCHEMA.properties.patch.properties.itinerary.items.properties.activities.type, "array");
  const patch = agentPatchOperations(detail, { itinerary: [{ day: 1, activities: [...detail.product.itinerary![0].activities!, night] }] });
  const next = applyProductPatch(detail.product, patch);
  assert.deepEqual((next.itinerary as any[])[0].activities.find((activity: any) => activity.type === "other"), night);
  assert.equal((next.itinerary as any[])[0].title, "送站");
});
