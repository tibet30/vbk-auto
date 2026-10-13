import assert from "node:assert/strict";
import test from "node:test";
import { applyProductPatch, applyProductPatchSafe } from "../../src/main/operations/product-patch.js";

const product = () => ({ operations: { hotelMatchingMode: "rules", hotelRules: { autoMatch: true, grades: [3, 4, 5] } } });
test("AI 不得把合法住宿规则覆盖为字符串布尔、指定名单或包装数组", () => {
  for (const rules of [
    { autoMatch: "true", grades: [3, 4, 5] },
    { autoMatch: true, grades: { item: ["3", "4", "5"] } },
    { autoMatch: true, grades: [3, 4, 5], specificHotelCity: { item: ["眉县"] } },
  ]) {
    for (const path of ["/operations/hotelRules", "/operations"]) {
      const before = product();
      const patch: any = [{ op: "replace", path, value: path === "/operations" ? { ...before.operations, hotelRules: rules } : rules }];
      assert.throws(() => applyProductPatch(before, patch), /住宿规则必须/);
      const result = applyProductPatchSafe(before, patch);
      assert.equal(result.applied, false); assert.deepEqual(result.product, before);
    }
  }
});
test("合法自动匹配规则可保存，不要求指定酒店", () => {
  const result = applyProductPatchSafe(product(), [{ op: "replace", path: "/operations/hotelRules", value: { autoMatch: true, grades: [5, 4, 3] } }]);
  assert.equal(result.applied, true);
  assert.deepEqual((result.product.operations as any).hotelRules, { autoMatch: true, grades: [5, 4, 3] });
});
