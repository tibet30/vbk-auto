import test from "node:test";
import assert from "node:assert/strict";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";

test("手动调整成人儿童估价时保留最低成团人数", () => {
  const product = { commercial: { pricing: { currency: "CNY", adult: 1500, child: 1200, minimumTravelers: 2 } } };
  const next = applyManualReviewField(product, { field: "pricing", adult: 1680, child: 980 });
  assert.deepEqual((next.commercial as Record<string, unknown>).pricing, { currency: "CNY", adult: 1680, child: 980, minimumTravelers: 2 });
  assert.equal(((product.commercial.pricing) as { adult: number }).adult, 1500);
});

test("手动调整会拒绝无效价格", () => {
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 0, child: 100 }), /成人价/);
});
