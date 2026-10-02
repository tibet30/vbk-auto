import test from "node:test";
import assert from "node:assert/strict";
import { needsTrafficLineBackfill } from "../../src/main/automation/traffic-line-backfill.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

test("已保存母草稿补回已核验交通计划后只需补交通阶段", () => {
  const product = {
    productId: "79141894",
    automation: { status: "succeeded", phases: [
      { phase: "basic", status: "completed" },
      { phase: "terms", status: "completed" },
      { phase: "preflight", status: "completed" },
    ] },
    product: {
      sales: { productForm: "privateTour" },
      itinerary: [],
      operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] } },
    },
  } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
  product.automation!.phases.push({ phase: "trafficLine", status: "completed" } as never);
  assert.equal(needsTrafficLineBackfill(product), false);
});
