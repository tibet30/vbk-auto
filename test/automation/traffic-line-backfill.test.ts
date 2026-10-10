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
  assert.equal(needsTrafficLineBackfill(product), true);
  product.automation!.trafficLine = { children: ["flightRoundTrip", "trainRoundTrip"].map(variant => ({ variant, verified: true, completedStages: ["finalReadback"] })) } as any;
  assert.equal(needsTrafficLineBackfill(product), false);
});


test("母产品成功但交通失败时只恢复交通，其他失败仍不得绕过", () => {
  const product = { productId: "79313974", product: { operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip"] } } },
    automation: { status: "succeeded", phases: [
      { phase: "basic", status: "completed" }, { phase: "trafficLine", status: "failed" }, { phase: "preflight", status: "completed" },
    ] } } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
  product.automation!.phases[0]!.status = "failed";
  assert.equal(needsTrafficLineBackfill(product), false);
});

test("已跳过的异步校验失败仍恢复现有子产品，资源确实不可用则不重跑", () => {
  const product = { productId: "79341474", product: { operations: { trafficLine: {
    enabled: true, variants: ["flightRoundTrip"],
  } } }, automation: { status: "succeeded", phases: [
    { phase: "basic", status: "completed" }, { phase: "trafficLine", status: "completed" },
    { phase: "preflight", status: "completed" },
  ], trafficLine: { children: [{ variant: "flightRoundTrip", childProductId: "79341666",
    completedStages: ["childCreated"], verified: false, skipped: true,
    failureReason: "子产品资源提交仍在 VBK 异步核验",
  }] } } } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
  const child = product.automation!.trafficLine!.children[0]!;
  child.failureReason = "没有任何可用的多出发城市";
  assert.equal(needsTrafficLineBackfill(product), false);
  child.failureReason = undefined;
  child.verified = true;
  child.completedStages.push("finalReadback");
  assert.equal(needsTrafficLineBackfill(product), false);
});


test("交通阶段网络失败且尚无子产品时不能借母产品成功结案", () => {
  const product = { productId: "parent", product: { operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] } } }, automation: { status: "succeeded", phases: [{ phase: "trafficLine", status: "completed" }, { phase: "preflight", status: "completed" }], trafficLine: { children: [], failureReason: "net::ERR_FAILED" } } } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
});
