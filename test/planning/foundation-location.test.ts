import assert from "node:assert/strict";
import test from "node:test";
import { runFoundationLocation } from "../../src/main/planning/three-stage-orchestrator.js";
import { createPlanningPlanV2 } from "../../src/main/planning/three-stage-orchestrator.js";

function depsFor(ai: any, product: Record<string, any>, events: string[] = []) {
  return {
    localProductId: "product-1",
    skeleton: {
      destination: "西藏自治区",
      province: "",
      city: "西藏自治区",
      days: 3,
      nights: 2,
      productForm: "privateTour" as const,
      productType: "domesticShort" as const,
      supplierProductCode: "SUP-1",
    },
    planner: {} as any,
    ai,
    runtime: {
      async loadCurrentProduct() { return product; },
      async writeModule(_id: string, _module: any, _path: string, value: any) {
        events.push("local-write");
        product.basicInfo = { ...product.basicInfo, ...value };
        return { ok: true };
      },
      async loadAcceptedModules() { return []; },
      async loadExistingResearchTasks() { return []; },
      async loadHistory() { return []; },
      async addResearchTask() { return "task-1"; },
    } as any,
    initialPlan: undefined,
    persist: async () => undefined,
    assertVbkLogin: async () => undefined,
    queryPoi: async () => ({ poiName: "拉萨布达拉宫景区", poiId: 1 } as any),
    resolveCover: async () => ({ complete: true, summary: "ok" }),
    resolveVehicle: async () => ({ complete: true, summary: "ok" }),
    privateTour: true,
    providerLabel: "test",
  };
}

test("第一阶段由 AI 输出标准省市并通过准入", async () => {
  const product = { basicInfo: { destination: "西藏自治区", destinationCity: "西藏自治区", province: "", days: 3 } };
  const calls: any[] = [];
  const ai = {
    async structureLocation(request: any) {
      calls.push(request);
      return { province: "西藏", destinationCity: "拉萨" };
    },
  };
  let plan = createPlanningPlanV2();
  const events: string[] = [];
  const result = await runFoundationLocation(depsFor(ai, product, events), plan, async (_id, patch) => {
    if (patch.status === "completed") events.push("remote-completed");
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === "skeleton" ? { ...node, ...patch } : node) };
  }, () => plan);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(product.basicInfo.province, "西藏");
  assert.equal(product.basicInfo.destinationCity, "拉萨");
  assert.deepEqual(events, ["local-write", "remote-completed"]);
});

test("第一阶段缺少标准城市最多重试三次，并把准入原因反馈给 AI", async () => {
  const product = { basicInfo: { destination: "成都", destinationCity: "成都", province: "", days: 2 } };
  const calls: any[] = [];
  const ai = {
    async structureLocation(request: any) {
      calls.push(request);
      return calls.length === 3 ? { province: "四川", destinationCity: "成都" } : { province: "四川", destinationCity: "" };
    },
  };
  let plan = createPlanningPlanV2();
  const result = await runFoundationLocation(depsFor(ai, product), plan, async (_id, patch) => {
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === "skeleton" ? { ...node, ...patch } : node) };
  }, () => plan);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.match(calls[1].previousError, /destinationCity/);
  assert.equal(product.basicInfo.destinationCity, "成都");
});

test("第一阶段三次地点准入都失败后停在 needs_user，不写入省市", async () => {
  const product = { basicInfo: { destination: "成都", destinationCity: "成都", province: "", days: 2 } };
  const calls: any[] = [];
  const ai = {
    async structureLocation(request: any) {
      calls.push(request);
      return { province: "四川", destinationCity: "四川" };
    },
  };
  const events: string[] = [];
  let plan = createPlanningPlanV2();
  const result = await runFoundationLocation(depsFor(ai, product, events), plan, async (_id, patch) => {
    if (patch.status === "completed") events.push("remote-completed");
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === "skeleton" ? { ...node, ...patch } : node) };
  }, () => plan);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 3);
  assert.match(calls[1].previousError, /destinationCity/);
  assert.equal(product.basicInfo.province, "");
  assert.deepEqual(events, []);
});
