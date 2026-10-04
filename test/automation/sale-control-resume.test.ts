import assert from "node:assert/strict";
import test from "node:test";
import { recoverCreatedShell } from "../../src/main/automation/automation.main/automation.main.recover-shell.js";
import { verifyExistingProductShellApi } from "../../src/main/automation/ctrip/sale-control/api.js";
import { prepareQueuedPhaseResume } from "../../src/main/automation/phase-retry.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

function fixture() {
  const product = { id: "local", productId: "79250117", product: {}, automation: {
    id: "original-run", status: "failed", currentPhase: "saleControl",
    phases: [{ phase: "basic", status: "pending" }, { phase: "preflight", status: "pending" }],
    logs: [], recovery: { phases: { saleControl: { phase: "saleControl", state: "needs_user", attempts: [],
      finalError: "应用重启导致自动录入被中断" } } },
  } } as unknown as ProductDetail;
  const saved: any[] = [];
  const ctx = { db: { saveAutomation: (_id: string, run: unknown) => saved.push(run) },
    browser: { page: async () => ({}) }, emit: () => {},
    runVbkPageExclusive: async (work: () => Promise<unknown>, phase?: string) => {
      assert.equal(phase, undefined, "readback must not request shell creation authorization");
      return work();
    },
  } as any;
  return { product, saved, ctx };
}

test("壳 ID 已保存：核验原 ID 后保留运行记录并衔接 basic", async () => {
  const { product, ctx, saved } = fixture();
  await recoverCreatedShell(ctx, product, async (_page, _data, id) => { assert.equal(id, "79250117"); });
  assert.equal(saved.length, 1);
  assert.equal(product.automation!.id, "original-run");
  assert.equal(product.automation!.recovery!.phases.saleControl.state, "completed");
  const next = prepareQueuedPhaseResume(product.automation!, ["basic", "preflight"], "basic");
  assert.equal(next.currentPhase, "basic");
  assert.equal(next.status, "running");
  assert.equal(next.phases[1].status, "pending");
});

test("回读失败、缺失 ID 或已完成阶段均不能伪造完成状态", async () => {
  const { product, ctx, saved } = fixture();
  await assert.rejects(recoverCreatedShell(ctx, product, async () => { throw new Error("expired"); }), /expired/);
  assert.equal(saved.length, 0);
  product.automation!.phases[0].status = "completed";
  await assert.rejects(recoverCreatedShell(ctx, product), /断点状态不一致/);
  product.productId = undefined;
  await assert.rejects(recoverCreatedShell(ctx, product), /避免重复创建/);
  assert.equal(saved.length, 0);
});

function readClient(patternId = 4) {
  const calls: string[] = [];
  return { calls, nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const endpoint = request.endpoint.split("/").at(-1);
    calls.push(endpoint);
    const data: Record<string, unknown> = {
      getCurrentUserInfo: { user: { providerId: 123 } },
      getSaleControlInfo: { vendorId: 123, regionDistributionChannelDtos: [], contractDtos: [{
        categoryDtos: [{ productCategoryName: "境内短途旅游", productCategoryId: 9 }],
        patternDtos: [{ productPatternName: "私家团", productPatternId: 4 }],
      }] },
      getProductBaseInfo: { saleControlInfo: { productCategoryID: 9, productPatternID: patternId, brandId: 42 } },
    };
    assert.ok(endpoint in data, `unexpected write: ${endpoint}`);
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...data[endpoint] as any }, durationMs: 1, ctx: {} };
  } };
}

test("已有产品壳只读核验不调用创建接口，类型形态不匹配停止", async () => {
  const product = { sales: { productType: "domesticShort", productForm: "privateTour" } };
  const client = readClient();
  await verifyExistingProductShellApi(client as any, product, "79250117");
  assert.deepEqual(client.calls, ["getCurrentUserInfo", "getSaleControlInfo", "getProductBaseInfo"]);
  await assert.rejects(verifyExistingProductShellApi(readClient(1) as any, product, "79250117"), /回读不一致/);
});

test("重启后的 start 将已有壳送入恢复入口，无 ID 仍阻止重建", async () => {
  const { DraftAutomation } = await import("../../src/main/automation/automation.main/automation.main.class.js");
  const { product } = fixture();
  const runner = new DraftAutomation({ getProduct: () => product } as any, {} as any,
    () => {}, async () => ({ action: "wait_for_user", reasoning: "test" }));
  const calls: unknown[] = [];
  (runner as any).runLocked = async (...args: unknown[]) => { calls.push(args); };
  await runner.start(product.id);
  assert.deepEqual(calls, [[product.id, "saleControl"]]);
  product.productId = undefined;
  await assert.rejects(runner.start(product.id), /避免重复创建/);
  assert.equal(calls.length, 1);
});
