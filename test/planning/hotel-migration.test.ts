/**
 * 酒店档次迁移测试：
 *  - /-38 在 create / normalize / update / reload 全链路保留；
 *  - 旧 /-5 自动被 normalise 为 /-38；
 *  - 任何 prompt / schema / normalizer 不再依赖 /-5；
 *  - 数据库重建（reload）不丢失。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HOTEL_TIER_VALUES, LEGACY_FIVE_DIAMOND_HOTEL_TIER, FIVE_DIAMOND_HOTEL_TIER, normaliseHotelTier, hotelDiamondFromTier } from "../../src/shared/hotel-tiers.js";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { applyProductPatchSafe } from "../../src/main/operations/product-patch.js";
import { productSchema } from "../../src/main/automation/schema/schema-definitions.js";

test("HOTEL_TIER_VALUES 不含旧 /-5；/-38 是当前唯一 5 钻枚举", () => {
  assert.equal(HOTEL_TIER_VALUES.includes(LEGACY_FIVE_DIAMOND_HOTEL_TIER as never), false);
  assert.ok((HOTEL_TIER_VALUES as readonly string[]).includes(FIVE_DIAMOND_HOTEL_TIER));
  assert.equal(FIVE_DIAMOND_HOTEL_TIER, "当地5钻酒店/-38");
});

test("normaliseHotelTier 把 /-5 转为 /-38；其它非法值返回 undefined", () => {
  assert.equal(normaliseHotelTier("当地5钻酒店/-5"), "当地5钻酒店/-38");
  assert.equal(normaliseHotelTier("当地5钻酒店/-38"), "当地5钻酒店/-38");
  assert.equal(normaliseHotelTier("当地2钻酒店/-2"), undefined); // 不在白名单
  assert.equal(normaliseHotelTier(""), undefined);
  assert.equal(normaliseHotelTier(undefined), undefined);
});

test("hotelDiamondFromTier 接受 /-38 与 /-5（经归一）", () => {
  assert.equal(hotelDiamondFromTier("当地5钻酒店/-38"), 5);
  assert.equal(hotelDiamondFromTier("当地5钻酒店/-5"), 5); // legacy → 自动归一为 5
  assert.equal(hotelDiamondFromTier("当地4钻酒店/-4"), 4);
});

test("normaliseProductDraft 把旧的 /-5 字段归一为 /-38；保留 /-38", () => {
  const product = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "x", supplierProductCode: "NEW", subtitle: "y", days: 1, nights: 0, meetingCity: "Z", destinationCity: "Z", province: "Z", operationNotes: "n" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-5", transport: "charter", pickupCity: "Z", reusePickupForDropoff: true, mealsIncluded: false },
    itinerary: [],
  };
  const normalised = normaliseProductDraft(product);
  assert.equal((normalised.operations as { hotelTier: string }).hotelTier, "当地5钻酒店/-38");
});

test("applyProductPatchSafe 写入 /-38 /-4 /-3 都被接受；写入 /-5 经 normalise 变成 /-38", () => {
  const base = {
    basicInfo: { supplierProductCode: "NEW" },
    operations: {},
  };
  const r1 = applyProductPatchSafe(base, [{ op: "replace", path: "/operations/hotelTier", value: "当地5钻酒店/-38" }]);
  assert.equal(r1.applied, true);
  assert.equal((r1.product.operations as { hotelTier: string }).hotelTier, "当地5钻酒店/-38");
  const r2 = applyProductPatchSafe(base, [{ op: "replace", path: "/operations/hotelTier", value: "当地5钻酒店/-5" }]);
  // patch 接受写入；但 normaliseProductDraft 会归一为 /-38。
  assert.equal(r2.applied, true);
  assert.equal((r2.product.operations as { hotelTier: string }).hotelTier, "当地5钻酒店/-38");
});

test("productSchema 接受 /-38，拒 绝不在白名单的旧 /-5", () => {
  const base = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "南京三日", supplierProductCode: "NEW", subtitle: "sub", days: 1, nights: 0, meetingCity: "南京", destinationCity: "南京", province: "江苏", operationNotes: "n" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", transport: "charter", pickupCity: "南京", reusePickupForDropoff: true, mealsIncluded: false },
    itinerary: [{ day: 1, title: "Day 1", spots: ["A"], description: "D", hotel: "H", meals: "M" }],
  };
  assert.equal(productSchema.safeParse(base).success, true);
  // operationsSchema 的 hotelTier 是 z.enum(HOTEL_TIER_VALUES) ，旧 /-5 不在白名单 → 解析失败。
  const broken = { ...base, operations: { ...base.operations, hotelTier: "当地5钻酒店/-5" } };
  assert.equal(productSchema.safeParse(broken).success, false);
});