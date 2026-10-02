import test from "node:test";
import assert from "node:assert/strict";
import { mergeSkeletonOperations } from "../../src/main/planning/skeleton-operation-merge.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";

test("重新生成骨架保留已核验的大交通计划", () => {
  const trafficLine = { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"],
    availability: { endpointPlan: { arrivalCity: "泸州", departureCity: "泸州" } } };
  const merged = mergeSkeletonOperations(
    { hotelTier: "当地3钻酒店/-3", trafficLine, pickupCity: "泸州", hotelResource: { resourceId: 1 } },
    { hotelTier: "当地5钻酒店/-38", pickupCity: "泸州" },
  );
  assert.deepEqual(merged.trafficLine, trafficLine);
  assert.equal(merged.hotelTier, "当地5钻酒店/-38");
  assert.equal(merged.hotelResource, undefined);
});

test("真实骨架写入不会删除交通子产品配置", async () => {
  let saved: Record<string, unknown> | undefined;
  const trafficLine = { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] };
  const db = {
    getProduct: () => ({ product: {
      basicInfo: { meetingCity: "泸州", destinationCity: "泸州", days: 2, nights: 1 },
      operations: { hotelTier: "当地3钻酒店/-3", pickupCity: "泸州", transport: "charter", trafficLine },
    } }),
    getSetting: () => null,
  };
  const runtime = new DbOrchestratorRuntime(db as any, undefined, {
    replace: (_id: string, product: Record<string, unknown>) => { saved = product; },
  } as any);
  const result = await runtime.writeModule("product", "skeleton", "/operations", {
    hotelTier: "当地3钻酒店/-3", pickupCity: "泸州", transport: "charter", mealsIncluded: false,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual((saved?.operations as Record<string, unknown>).trafficLine, trafficLine);
});
