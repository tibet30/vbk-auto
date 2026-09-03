import test from "node:test";
import assert from "node:assert/strict";
import { executeStageOutput } from "../../src/main/planning/stage-runner.js";
import { runSingleStage } from "../../src/main/planning/single-stage-runner.js";
import { DbOrchestratorRuntime, isAcceptablePlanningRegionName, isProvinceLevelName, normaliseProvinceName, resolveTravelScope } from "../../src/main/planning/runtime.js";

const basicInfoValue = (province: string) => ({
  subtitle: "内蒙古精华之旅",
  province,
  operationNotes: "按最终行程核对资源",
});

function runtimeWith(product: Record<string, unknown>) {
  const writes: Array<{ module: string; value: unknown }> = [];
  return {
    writes,
    runtime: {
      async loadCurrentProduct() { return product; },
      async writeModule(_localProductId: string, module: string, _path: string, value: unknown) {
        if (module === "basicInfo" && value && typeof value === "object" && !Array.isArray(value)) {
          const existing = product.basicInfo as Record<string, unknown>;
          const incoming = { ...(value as Record<string, unknown>) };
          if (typeof existing.province === "string" && existing.province.trim()) delete incoming.province;
          product.basicInfo = { ...existing, ...incoming };
          value = incoming;
        }
        writes.push({ module, value });
        return { ok: true as const };
      },
    },
  };
}

async function executeBasicInfo(destination: string, province: string, existingProvince?: string) {
  const { runtime, writes } = runtimeWith({
    basicInfo: {
      meetingCity: destination,
      destinationCity: destination,
      ...(existingProvince === undefined ? {} : { province: existingProvince }),
    },
  });
  const result = await executeStageOutput({
    stage: "basicInfo",
    localProductId: "province-normalization",
    runtime: runtime as any,
    output: {
      reply: "基础信息",
      modules: [{ module: "basicInfo", status: "accepted", value: basicInfoValue(province) }],
    },
  });
  return { result, writes };
}

test("内蒙古与内蒙古自治区归一化为同一省级名称", () => {
  assert.equal(normaliseProvinceName("内蒙古"), "内蒙古");
  assert.equal(normaliseProvinceName("内蒙古自治区"), "内蒙古");
  assert.equal(isProvinceLevelName("内蒙古"), true);
  assert.equal(isProvinceLevelName("内蒙古自治区"), true);
});

test("省级目的地解析为默认核心游览城市和近邻城市", () => {
  assert.deepEqual(resolveTravelScope("河南"), {
    input: "河南",
    isProvinceLevel: true,
    primaryCity: "郑州",
    nearbyCoreCities: ["开封", "洛阳"],
  });
  assert.deepEqual(resolveTravelScope("内蒙古自治区"), {
    input: "内蒙古自治区",
    isProvinceLevel: true,
    primaryCity: "呼和浩特",
    nearbyCoreCities: ["包头"],
  });
});

test("普通城市目的地保持原城市游玩范围", () => {
  assert.deepEqual(resolveTravelScope("太原"), {
    input: "太原",
    isProvinceLevel: false,
    primaryCity: "太原",
    nearbyCoreCities: [],
  });
});

test("境外上级地区可以作为 planning province，但不能直接照抄普通城市", () => {
  assert.equal(isAcceptablePlanningRegionName("俄罗斯", "伊尔库茨克"), true);
  assert.equal(isAcceptablePlanningRegionName("伊尔库茨克州", "伊尔库茨克"), true);
  assert.equal(isAcceptablePlanningRegionName("伊尔库茨克", "伊尔库茨克"), false);
});

test("skeleton 阶段把省级目的地的 pickupCity 写为核心城市", async () => {
  let skeletonValue: Record<string, unknown> | undefined;
  const result = await runSingleStage({
    stage: "skeleton",
    state: {
      localProductId: "province-skeleton",
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "running",
      updatedAt: new Date().toISOString(),
    },
    skeleton: {
      destination: "河南",
      days: 2,
      nights: 1,
      productForm: "privateTour",
      productType: "domesticShort",
      supplierProductCode: "NEW",
    },
    runtime: {
      loadAcceptedModules: async () => [],
      writeModule: async (_id: string, _module: string, _path: string, value: unknown) => {
        skeletonValue = value as Record<string, unknown>;
        return { ok: true as const };
      },
    } as any,
    planner: {} as any,
    retryLimit: 1,
    history: [],
    existingTasks: [],
  });
  assert.equal(result.status, "completed");
  assert.equal(skeletonValue?.pickupCity, "郑州");
  assert.equal(skeletonValue?.hotelTier, "当地5钻酒店/-38");
});

test("真实 runtime 写入 skeleton 时同步把省级 meetingCity / destinationCity 改为核心城市", async () => {
  let savedProduct: Record<string, unknown> | undefined;
  const db = {
    getProduct() {
      return {
        product: {
          basicInfo: { meetingCity: "黑龙江", destinationCity: "黑龙江", days: 2, nights: 1 },
          operations: { hotelTier: "5钻", pickupCity: "", transport: "privateCar" },
        },
      };
    },
    getSetting() { return null; },
  };
  const productMutations = {
    replace(_localProductId: string, product: Record<string, unknown>) {
      savedProduct = product;
    },
  };
  const runtime = new DbOrchestratorRuntime(db as any, undefined, productMutations as any);
  const result = await runtime.writeModule("province-runtime", "skeleton", "/operations", {
    hotelTier: "5钻",
    pickupCity: "哈尔滨",
    transport: "privateCar",
  });

  assert.deepEqual(result, { ok: true });
  const basicInfo = savedProduct?.basicInfo as Record<string, unknown>;
  assert.equal(basicInfo.meetingCity, "哈尔滨");
  assert.equal(basicInfo.destinationCity, "哈尔滨");
});

test("目的地输入内蒙古时 basicInfo 可以接受并写入", async () => {
  const { result, writes } = await executeBasicInfo("内蒙古", "内蒙古");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(writes.length, 1);
});

test("目的地输入内蒙古自治区时 basicInfo 可以接受并写入", async () => {
  const { result, writes } = await executeBasicInfo("内蒙古自治区", "内蒙古自治区");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(writes.length, 1);
});

test("普通城市不能直接作为 province", async () => {
  const { result, writes } = await executeBasicInfo("太原", "太原");
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]?.reason ?? "", /province/);
  assert.equal(writes.length, 0);
});

test("境外产品 basicInfo 可以接受国家或一级行政区作为 province", async () => {
  const { result, writes } = await executeBasicInfo("伊尔库茨克", "俄罗斯");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(writes.length, 1);
});

test("已有合法 province 不被 AI 输出覆盖", async () => {
  const { result, writes } = await executeBasicInfo("呼和浩特", "山西", "内蒙古自治区");
  assert.equal(result.accepted.length, 1);
  assert.equal(writes.length, 1);
  assert.equal((writes[0]?.value as Record<string, unknown>).province, undefined);
});
