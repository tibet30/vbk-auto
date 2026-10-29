import test from "node:test";
import assert from "node:assert/strict";
import { backfillEnteredItineraryDays } from "../../src/main/agent/integration-setup/entered-days-backfill.js";
import { installLogSink } from "../../src/shared/log-timestamp.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

function product(entered?: number): ProductDetail {
  return { id: "local-1", productId: "79000001", product: { basicInfo: { days: 4 } },
    automation: { id: "run-1", status: "failed", logs: [], phases: [], ...(entered ? { enteredItineraryDays: entered } : {}) } } as unknown as ProductDetail;
}

function harness(initial: ProductDetail) {
  let current = initial;
  const saved: unknown[] = [];
  const context = {
    db: { getProduct: () => current, saveAutomation: (_id: string, run: unknown) => { saved.push(run); } },
    browser: { page: async () => ({}) },
    productWorkflows: { runVbkPageExclusive: <T>(fn: () => Promise<T>) => fn() },
  };
  return { context: context as never, saved, set: (next: ProductDetail) => { current = next; } };
}

test("已知已录入天数时不查询远端", async () => {
  const h = harness(product(2));
  let reads = 0;
  await backfillEnteredItineraryDays(h.context, "local-1", async () => { reads += 1; return 3; });
  assert.equal(reads, 0);
  assert.deepEqual(h.saved, []);
});

test("远端只读查询失败时不写入，并记录告警", async () => {
  const h = harness(product());
  const warnings: unknown[][] = [];
  installLogSink((level, args) => { if (level === "warn") warnings.push([...args]); });
  try {
    await backfillEnteredItineraryDays(h.context, "local-1", async () => { throw new Error("网络超时"); });
  } finally { installLogSink(); }
  assert.deepEqual(h.saved, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]![0], "[duration] 远端天数只读查询失败");
  const detail = warnings[0]![1] as { localProductId: string; productId: string; error: Error };
  assert.deepEqual([detail.localProductId, detail.productId, detail.error.message], ["local-1", "79000001", "网络超时"]);
});

test("查询期间运行记录或远端产品变化时不写入", async () => {
  for (const change of [(p: ProductDetail) => { p.automation!.id = "run-2"; }, (p: ProductDetail) => { p.productId = "79000002"; }]) {
    const h = harness(product());
    await backfillEnteredItineraryDays(h.context, "local-1", async () => {
      const next = structuredClone(product());
      change(next);
      h.set(next);
      return 3;
    });
    assert.deepEqual(h.saved, []);
  }
  // 对照：无变化时写入查询到的天数。
  const h = harness(product());
  await backfillEnteredItineraryDays(h.context, "local-1", async () => 3);
  assert.equal((h.saved[0] as { enteredItineraryDays: number }).enteredItineraryDays, 3);
});
