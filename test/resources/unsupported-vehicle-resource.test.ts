import assert from "node:assert/strict";
import test from "node:test";
import { productNeedsVehicleResource } from "../../src/shared/product-form.js";
import { ensureVehicleResourceApi } from "../../src/main/automation/ctrip/vehicle-resource-api.js";
import { ensureTrafficLineVehicleBinding, ensureTrafficLineVehicleDraft } from "../../src/main/automation/ctrip/traffic-line/helpers.js";
import { completeUnsupportedVehiclePhase, resourceRecoveryPhases } from "../../src/main/automation/automation.main/automation.main.resource-handlers.js";
import { preparePhaseRetry } from "../../src/main/automation/phase-retry.js";

// 来自 546739af 的失败输入：拼小团保留用车报价及资源 ID，但团态禁止绑定。
const vehicleResource = {
  requestedTotalCost: 3600,
  resourceGroupId: 2206667,
  resourceGroupName: "5座经济3600+5座舒适3900+7座7200",
};

for (const productForm of ["groupTour", "semiSelfGuided"]) {
  test(`${productForm} 的残留用车配置不触发父产品或交通子产品资源写入`, async () => {
    const product = { sales: { productForm, splitGroup: true }, operations: { transport: "shared", vehicleResource } };
    const before = structuredClone(product);
    let requests = 0;
    const page = { evaluate: async () => { requests += 1; throw new Error("禁止平台写入"); } };
    assert.equal(productNeedsVehicleResource(product), false);
    assert.ok("skipped" in await ensureVehicleResourceApi(page, product, "79239248"));
    await ensureTrafficLineVehicleDraft(page as any, "child", product);
    await ensureTrafficLineVehicleBinding(page as any, "child", product);
    assert.equal(requests, 0);

    const run: any = {
      phases: [{ phase: "hotelResource", status: "completed" }, { phase: "vehicleResource", status: "failed" }, { phase: "terms", status: "pending" }],
      recovery: { phases: { vehicleResource: { state: "needs_user", finalError: "跟团游/半自助产品不可添加用车资源组", attempts: [{ attempt: 1 }] } } },
    };
    let persisted = 0;
    assert.equal(completeUnsupportedVehiclePhase(product, run, "vehicleResource", 1, () => {}, () => { persisted += 1; }), true);
    assert.deepEqual(run.phases.map((phase: any) => phase.status), ["completed", "completed", "pending"]);
    assert.equal(run.recovery.phases.vehicleResource.state, "completed");
    assert.equal(run.recovery.phases.vehicleResource.finalError, undefined);
    assert.equal(run.recovery.phases.vehicleResource.attempts.length, 1);
    assert.equal(persisted, 1);
    assert.deepEqual(product, before);
  });
}

test("私家团必需用车及自由行显式用车配置沿用原规则", () => {
  assert.equal(productNeedsVehicleResource({ sales: { productForm: "privateTour" } }), true);
  assert.equal(productNeedsVehicleResource({ sales: { productForm: "freeTravel" }, operations: { vehicleResource } }), true);
  assert.equal(productNeedsVehicleResource({ sales: { productForm: "freeTravel" } }), false);
});

test("历史失败用车阶段移出新阶段表后仍能从原断点恢复", () => {
  const product = { sales: { productForm: "groupTour" }, operations: { vehicleResource } };
  const previous: any = { id: "run", status: "failed", logs: [], phases: [
    { phase: "basic", status: "completed" }, { phase: "hotelResource", status: "completed" },
    { phase: "vehicleResource", status: "failed" }, { phase: "terms", status: "pending" }, { phase: "preflight", status: "pending" },
  ] };
  const phases = ["basic", "hotelResource", "terms", "preflight"];
  const resumedPhases = resourceRecoveryPhases(product, phases, previous, "vehicleResource");
  const run = preparePhaseRetry(previous, resumedPhases, "vehicleResource");
  assert.equal(completeUnsupportedVehiclePhase(product, run, "vehicleResource", 2, () => {}, () => {}), true);
  assert.deepEqual(run.phases.map(item => item.status), ["completed", "completed", "completed", "pending", "pending"]);
  assert.deepEqual(resourceRecoveryPhases(product, phases, previous), phases);
  assert.deepEqual(resourceRecoveryPhases({sales: {productForm: "privateTour"}}, phases, previous, "vehicleResource"), phases);
});
