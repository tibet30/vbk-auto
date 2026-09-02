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

test("第一阶段将遗留省级城市锚点提升为该省主城市", async () => {
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
  assert.equal(product.basicInfo.meetingCity, "拉萨");
  assert.equal(product.basicInfo.destinationCity, "拉萨");
  assert.deepEqual(events, ["local-write", "remote-completed"]);
  assert.deepEqual((product.basicInfo as any).province, "西藏");
});

test("第一阶段忽略 AI 返回的其它城市", async () => {
  const product = { basicInfo: { destination: "成都", destinationCity: "成都", province: "", days: 2 } };
  const calls: any[] = [];
  const ai = {
    async structureLocation(request: any) {
      calls.push(request);
      return { province: "四川", destinationCity: "西安" };
    },
  };
  let plan = createPlanningPlanV2();
  const result = await runFoundationLocation(depsFor(ai, product), plan, async (_id, patch) => {
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === "skeleton" ? { ...node, ...patch } : node) };
  }, () => plan);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(product.basicInfo.destinationCity, "成都");
});

test("第一阶段省份不合法时仍然重试并停在 needs_user", async () => {
  const product = { basicInfo: { destination: "成都", destinationCity: "成都", province: "", days: 2 } };
  const calls: any[] = [];
  const ai = {
    async structureLocation(request: any) {
      calls.push(request);
      return { province: "太原", destinationCity: "西安" };
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
  assert.match(calls[1].previousError, /province/);
  assert.equal(product.basicInfo.province, "");
  assert.deepEqual(events, []);
});

test("第一阶段境外目的地接受国家或一级行政区作为 province", async () => {
  const product = { basicInfo: { destination: "伊尔库茨克", destinationCity: "伊尔库茨克", province: "", days: 3 } };
  const ai = {
    async structureLocation() {
      return { province: "俄罗斯", destinationCity: "伊尔库茨克" };
    },
  };
  let plan = createPlanningPlanV2();
  const result = await runFoundationLocation(depsFor(ai, product), plan, async (_id, patch) => {
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === "skeleton" ? { ...node, ...patch } : node) };
  }, () => plan);
  assert.equal(result.ok, true);
  assert.equal(product.basicInfo.province, "俄罗斯");
  assert.equal(product.basicInfo.destinationCity, "伊尔库茨克");
});
