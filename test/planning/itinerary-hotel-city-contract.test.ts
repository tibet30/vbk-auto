import assert from "node:assert/strict";
import test from "node:test";
import { executeStageOutput } from "../../src/main/planning/stage-runner.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";

const days = ["眉", "太白", "留坝", "洋", "汉中", ""].map((hotelCity, index) => ({
  day: index + 1, title: `第 ${index + 1} 天接送`, description: "按原路线专车接送。",
  hotel: index < 5 ? "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店" : "无当日住宿安排",
  hotelCity, meals: "自理", spots: [],
  activities: [{ time: "上午", title: "专车接送", detail: "按原路线接送。", type: "transport" }],
}));

/** Capture the write boundary; database hotel normalization belongs to the full product regression. */
function captureRuntime() {
  const writes: Array<{ module: string; path: string; value: unknown }> = [];
  const runtime: OrchestratorRuntime = {
    async writeModule(_id, module, path, value) { writes.push({ module, path, value }); return { ok: true }; },
    async loadCurrentProduct() { return {}; },
    async loadAcceptedModules() { return []; },
    async loadHistory() { return []; },
    async loadExistingResearchTasks() { return []; },
    async addResearchTask() { throw new Error("行程校验不应创建核查任务"); },
  };
  return { runtime, writes };
}

test("跨城 hotelCity 通过生产阶段校验并完整传入写入口，兼容返程日空字段", async () => {
  const { runtime, writes } = captureRuntime();
  const result = await executeStageOutput({ stage: "itinerary", localProductId: "isolated-product",
    runtime,
    output: { reply: "保留各晚住宿城市", modules: [{ module: "itinerary", status: "accepted", value: days }] },
  });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.hasAccepted, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].module, "itinerary");
  assert.equal(writes[0].path, "/itinerary");
  assert.deepEqual((writes[0].value as Array<{ hotelCity: string }>).map(day => day.hotelCity),
    ["眉", "太白", "留坝", "洋", "汉中", ""]);
});

test("旧行程省略 hotelCity 仍可接受，行政字段前后空白被清理", async () => {
  const { runtime, writes } = captureRuntime();
  const input = structuredClone(days) as Array<Record<string, unknown>>;
  input[0].hotelCity = "  眉  ";
  delete input[5].hotelCity;
  const result = await executeStageOutput({ stage: "itinerary", localProductId: "isolated-product", runtime,
    output: { reply: "保留兼容格式", modules: [{ module: "itinerary", status: "accepted", value: input }] },
  });
  assert.equal(result.hasAccepted, true);
  const written = writes[0].value as Array<Record<string, unknown>>;
  assert.equal(written[0].hotelCity, "眉");
  assert.equal(Object.hasOwn(written[5], "hotelCity"), false);
});

test("补齐 hotelCity 不放宽未知字段校验，拒绝结果不能触发写入", async () => {
  const { runtime, writes } = captureRuntime();
  for (const extra of [{ hotelCity: 123 }, { unsupportedHotelCity: "西安" }]) {
    const result = await executeStageOutput({ stage: "itinerary", localProductId: "isolated-product",
      runtime, output: { reply: "无效字段",
        modules: [{ module: "itinerary", status: "accepted", value: [{ ...days[0], ...extra }, ...days.slice(1)] }] },
    });
    assert.equal(result.hasAccepted, false);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(writes, []);
  }
});
