import assert from "node:assert/strict";
import test from "node:test";
import { prepareWizardStageRetry } from "../../src/main/agent/integration-setup/wizard-stage-retry.ts";
import { unlockedMenusWithExtensions } from "../automation/product-menu-fixture.ts";

const productId = "79735280";

function context(menus: ReturnType<typeof unlockedMenusWithExtensions>) {
  const calls: string[] = [];
  const page = { evaluate: async (_fn: unknown, request: { endpoint: string }) => {
    calls.push(request.endpoint);
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...menus }, durationMs: 1, ctx: {} };
  } };
  return {
    calls,
    context: {
      db: { getProduct: () => ({ id: "local", productId }) },
      browser: { requestPage: async () => page },
      productWorkflows: { runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() },
    } as any,
  };
}

test("12 项菜单在 -80 时仍为产品信息创建窄范围下一步确认", async () => {
  for (const extensionState of ["T", "F"] as const) {
    const menus = unlockedMenusWithExtensions(productId);
    menus.maxStep = -80;
    menus.menus.forEach((menu, index) => {
      menu.enabled = index < 2 ? "T" : index >= 10 ? extensionState : "F";
    });
    const f = context(menus);

    const plan = await prepareWizardStageRetry(f.context, "local", "basic");

    assert.equal(plan.alreadyAdvanced, false);
    assert.deepEqual(plan.scope, ["vbk.write_phase:basic"]);
    assert.equal(f.calls.filter(endpoint => endpoint.endsWith("/getSubMenu.json")).length, 1);
  }
});

test("12 项全为 T 但 maxStep 未完成时不能误判为已越过向导", async () => {
  const menus = unlockedMenusWithExtensions(productId);
  menus.maxStep = -80;
  const f = context(menus);

  await assert.rejects(
    () => prepareWizardStageRetry(f.context, "local", "basic"),
    /连续官方状态/,
  );
});
