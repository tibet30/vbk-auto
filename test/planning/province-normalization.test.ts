import test from "node:test";
import assert from "node:assert/strict";
import { executeStageOutput } from "../../src/main/planning/stage-runner.js";
import { isProvinceLevelName, normaliseProvinceName } from "../../src/main/planning/runtime.js";

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

test("已有合法 province 不被 AI 输出覆盖", async () => {
  const { result, writes } = await executeBasicInfo("呼和浩特", "山西", "内蒙古自治区");
  assert.equal(result.accepted.length, 1);
  assert.equal(writes.length, 1);
  assert.equal((writes[0]?.value as Record<string, unknown>).province, undefined);
});
