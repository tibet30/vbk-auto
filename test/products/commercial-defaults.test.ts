import test from "node:test";
import assert from "node:assert/strict";
import { defaultCommercialInventory } from "../../src/main/data/commercial-defaults.js";

test("defaultCommercialInventory 使用当天到一年后的默认班期库存", () => {
  assert.deepEqual(defaultCommercialInventory(new Date(2026, 7, 12, 13, 30, 0)), {
    startDate: "2026-08-12",
    endDate: "2027-08-12",
    dailyQuota: 30,
  });
});

test("defaultCommercialInventory 处理闰年 2 月 29 日：下一年夹到 2 月 28 日", () => {
  assert.deepEqual(defaultCommercialInventory(new Date(2024, 1, 29, 9, 0, 0)), {
    startDate: "2024-02-29",
    endDate: "2025-02-28",
    dailyQuota: 30,
  });
});
