/** 规划完成后处理：VBK 未登录或状态查询失败时只记日志返回，不写占位封面、不合并变更。 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyCompletedAfterPlanningResult } from "../../src/main/ipc/planning-ipc/postprocess.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";

function stubContext(status: () => Promise<unknown>) {
  const product = {
    presentation: { recommendation: "推荐", features: "特色", cover: { source: "ctripLibrary", poi: "晋祠" } },
    itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: "晋祠", poiId: 1 }] }],
  };
  const stored = { id: "local-1", product };
  const merges: unknown[][] = [];
  const context = {
    db: { getProduct: () => stored },
    productWorkflows: { runVbkPageExclusive: <T>(task: () => Promise<T>) => task() },
    browser: { status },
    productMutations: { commands: { mergeChanges: (...args: unknown[]) => { merges.push(args); } } },
    broadcastProduct: () => {},
    remoteProducts: {},
  } as unknown as MainIpcContext;
  return { context, merges, stored };
}

for (const [name, status] of [
  ["browser.status() 返回 loggedIn=false", async () => ({ loggedIn: false })],
  ["browser.status() 抛错", async () => { throw new Error("browser not ready"); }],
] as const) {
  test(`未登录分支：${name} 时不写占位封面、不合并变更、正常返回`, async () => {
    const { context, merges, stored } = stubContext(status);
    await assert.doesNotReject(() => applyCompletedAfterPlanningResult(context, { localProductId: "local-1", providerLabel: "test" }));
    assert.equal(merges.length, 0);
    assert.equal((stored.product.presentation as Record<string, unknown>).coverFallback, undefined);
  });
}
