import assert from "node:assert/strict";
import test from "node:test";
import { localBusinessDate } from "../../src/main/automation/ctrip/pricing-api.ts";
import { verifyPricingInventoryReadback } from "../../src/main/automation/ctrip/pricing-readback.ts";

test("价格库存重复首日不能抵消缺失的次日", async () => {
  const first = localBusinessDate();
  const next = new Date(`${first}T00:00:00`); next.setDate(next.getDate() + 1);
  const second = localBusinessDate(next);
  const page = { evaluate: async (_fn: unknown, request: any) => {
    const endpoint = String(request?.endpoint ?? "");
    if (endpoint.endsWith("/getPackageList")) return { status: 200, payload: {
      ResponseStatus: { Ack: "Success" }, itemList: [{ singleResourceId: 11, optionalResourceId: 22 }],
    }, durationMs: 1, ctx: {} };
    if (endpoint.endsWith("/GetBatchOperateSchedule")) return { status: 200, payload: {
      ResponseStatus: { Ack: "Success" }, dates: [
        { adultPrice: { date: first, cost: 100, marketPrice: 200 }, inventory: { total: 10 } },
        { adultPrice: { date: first, cost: 100, marketPrice: 200 }, inventory: { total: 10 } },
      ],
    }, durationMs: 1, ctx: {} };
    throw new Error(`unexpected endpoint ${endpoint}`);
  } };
  await assert.rejects(() => verifyPricingInventoryReadback(page, {
    commercial: { pricing: { adult: 200, cost: { adult: 100 } }, inventory: { startDate: first, endDate: second, dailyQuota: 10 } },
  }, "78490990"), /缺少 1\/2 个日期/);
});
