import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { ResearchTaskProposal } from "../../src/shared/contracts-planning.js";

test("规划阶段拿到已核验的 AI 候选后立即写回本地行程，不进入人工编辑器", async () => {
  let written: unknown;
  const runtime: OrchestratorRuntime = {
    resolvePoiSelection: async (localProductId, keyword, context) => {
      assert.equal(localProductId, "planning-auto-write");
      assert.equal(keyword, "日喀则非物质文化遗产中心");
      assert.deepEqual(context, { destinationCity: "日喀则", province: "西藏" });
      return {
        status: "available",
        match: { poiName: "非物质文化遗产展示中心", poiId: 150237367, province: "西藏", city: "日喀则" },
      };
    },
    loadExistingResearchTasks: async () => [],
    writeModule: async (_localProductId, module, path, value) => {
      assert.equal(module, "itinerary");
      assert.equal(path, AI_WRITABLE_PATHS.itinerary);
      written = value;
      return { ok: true };
    },
    addResearchTask: async () => "task",
    loadHistory: async () => [],
    loadCurrentProduct: async () => ({
      basicInfo: { destinationCity: "日喀则", province: "西藏" },
      itinerary: [{ day: 1, spots: [{ name: "日喀则非物质文化遗产中心", poiName: null, poiId: null }] }],
    }),
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "planning-auto-write", destination: "日喀则", runtime, persistedTaskKeys: new Set(),
  });

  assert.deepEqual((written as Array<{ spots: unknown[] }>)[0].spots[0], {
    name: "日喀则非物质文化遗产中心",
    poiName: "非物质文化遗产展示中心",
    poiId: 150237367,
    province: "西藏",
    city: "日喀则",
  });
});

test("单个 POI 查询悬挂会超时，后续景点仍写回，且不伪造未匹配任务", async () => {
  const product = {
    itinerary: [{ day: 1, spots: [
      { name: "慢查询景点", poiName: null, poiId: null },
      { name: "可匹配景点", poiName: null, poiId: null },
    ] }],
  };
  const queried: string[] = [];
  const tasks: ResearchTaskProposal[] = [];
  let written: unknown;
  const runtime: OrchestratorRuntime = {
    suggestPoi: async (keyword) => {
      queried.push(keyword);
      if (keyword === "慢查询景点") return new Promise<never>(() => undefined);
      return { poiName: "可匹配景点（VBK）", poiId: 1024 };
    },
    loadExistingResearchTasks: async () => [],
    writeModule: async (_localProductId, module, path, value) => {
      assert.equal(module, "itinerary");
      assert.equal(path, AI_WRITABLE_PATHS.itinerary);
      written = value;
      return { ok: true };
    },
    addResearchTask: async (_localProductId, task) => {
      if (!tasks.some((item) => item.type === task.type && item.label === task.label)) tasks.push(task);
      return task.label;
    },
    loadHistory: async () => [],
    loadCurrentProduct: async () => product,
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "poi-timeout",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
    queryTimeoutMs: 1,
  });

  assert.deepEqual(queried, ["慢查询景点", "可匹配景点"]);
  const spots = (written as { spots: Array<{ poiName: string | null; poiId: number | null }> }[])[0].spots;
  assert.deepEqual(spots[0], { name: "慢查询景点", poiName: null, poiId: null });
  assert.deepEqual(spots[1], { name: "可匹配景点", poiName: "可匹配景点（VBK）", poiId: 1024 });
  assert.equal(tasks.length, 0, "超时与成功匹配都不能生成 POI 核查任务");
});

test("只有成功响应且没有候选时创建 canonical POI 核查任务", async () => {
  const tasks: ResearchTaskProposal[] = [];
  const runtime: OrchestratorRuntime = {
    suggestPoi: async () => null,
    loadExistingResearchTasks: async () => [],
    writeModule: async () => ({ ok: true }),
    addResearchTask: async (_localProductId, task) => {
      tasks.push(task);
      return task.label;
    },
    loadHistory: async () => [],
    loadCurrentProduct: async () => ({
      itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: null, poiId: null }] }],
    }),
    loadAcceptedModules: async () => ["itinerary"],
  };

  const result = await enrichItineraryPois({
    localProductId: "poi-no-match",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(tasks, [{
    label: "核查 晋祠 的 VBK POI 映射",
    type: "vbk",
    detail: "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
  }]);
  assert.deepEqual(result, tasks);
});

test("已存在的未匹配 POI 核查项不再重复写入", async () => {
  let taskWrites = 0;
  const runtime: OrchestratorRuntime = {
    suggestPoi: async () => null,
    loadExistingResearchTasks: async () => [],
    writeModule: async () => ({ ok: true }),
    addResearchTask: async () => {
      taskWrites += 1;
      return "existing-task";
    },
    loadHistory: async () => [],
    loadCurrentProduct: async () => ({
      itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: null, poiId: null }] }],
    }),
    loadAcceptedModules: async () => ["itinerary"],
  };

  const result = await enrichItineraryPois({
    localProductId: "poi-existing-no-match",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(["vbk::核查 晋祠 的 VBK POI 映射"]),
  });

  assert.equal(taskWrites, 0);
  assert.deepEqual(result, []);
});

test("完整 POI 不发起查询也不重写 itinerary；只查询缺失的景点", async () => {
  const queried: string[] = [];
  let writes = 0;
  const runtime: OrchestratorRuntime = {
    suggestPoi: async (keyword) => {
      queried.push(keyword);
      return { poiName: `${keyword}（VBK）`, poiId: 2048 };
    },
    loadExistingResearchTasks: async () => [],
    writeModule: async () => {
      writes += 1;
      return { ok: true };
    },
    addResearchTask: async () => "id",
    loadHistory: async () => [],
    loadCurrentProduct: async () => ({
      itinerary: [{ day: 1, spots: [
        { name: "已有 POI", poiName: "已有 POI（VBK）", poiId: 1 },
        { name: "缺失 POI", poiName: null, poiId: null },
      ] }],
    }),
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "poi-only-missing",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(queried, ["缺失 POI"]);
  assert.equal(writes, 1);
});

test("完整 itinerary 在补全入口中零查询、零写回", async () => {
  let queries = 0;
  let writes = 0;
  const runtime: OrchestratorRuntime = {
    suggestPoi: async () => {
      queries += 1;
      return null;
    },
    loadExistingResearchTasks: async () => [],
    writeModule: async () => {
      writes += 1;
      return { ok: true };
    },
    addResearchTask: async () => "id",
    loadHistory: async () => [],
    loadCurrentProduct: async () => ({
      itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: "晋祠博物馆", poiId: 83199 }] }],
    }),
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "poi-complete",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.equal(queries, 0);
  assert.equal(writes, 0);
});

test("原始名称未命中时保留原景点和原位置，并创建人工核查项", async () => {
  const queries: string[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "日喀则非物质文化遗产中心", poiName: null, poiId: null }, { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 76348 }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      return null;
    },
  });
  const result = await enrichItineraryPois({ localProductId: "unmatched-kept", destination: "日喀则", runtime, persistedTaskKeys: new Set() });
  assert.deepEqual(queries, ["日喀则非物质文化遗产中心"]);
  assert.deepEqual(runtime.tasks, [{
    type: "vbk",
    label: "核查 日喀则非物质文化遗产中心 的 VBK POI 映射",
    detail: "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
  }]);
  assert.deepEqual(result, runtime.tasks);
  assert.deepEqual((await runtime.loadCurrentProduct("unmatched-kept")).itinerary, [{
    day: 1,
    spots: [{ name: "日喀则非物质文化遗产中心", poiName: null, poiId: null }, { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 76348 }],
  }]);
});

test("原始名称直接命中会写入真实 POI", async () => {
  let written: any;
  const directRuntime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "西安钟楼", poiName: null, poiId: null }] }] },
    suggestPoi: async () => ({ poiName: "西安钟楼", poiId: 1 }),
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    localProductId: "fallback-direct", destination: "西安", runtime: directRuntime, persistedTaskKeys: new Set(),
  });
  assert.deepEqual(written[0].spots[0], {
    name: "西安钟楼", poiName: "西安钟楼", poiId: 1,
  });
});

test("官方名括号别名会做确定性查询并写回", async () => {
  const queried: string[] = [];
  let written: any;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "永祚寺（双塔寺）", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queried.push(keyword);
      return keyword === "双塔寺" ? { poiName: "双塔寺", poiId: 77967 } : null;
    },
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    localProductId: "bracket-alias",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
  });
  assert.deepEqual(queried, ["永祚寺（双塔寺）", "双塔寺"]);
  assert.deepEqual(written[0].spots[0], {
    name: "永祚寺（双塔寺）", poiName: "双塔寺", poiId: 77967,
  });
});

test("未命中时不会重复创建已有 canonical 核查项", async () => {
  const taskWrites: ResearchTaskProposal[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async () => null,
  });
  runtime.addResearchTask = async (_localProductId, task) => {
    taskWrites.push(task);
    return "existing-task";
  };

  const result = await enrichItineraryPois({
    localProductId: "unmatched-existing", destination: "西安", runtime,
    persistedTaskKeys: new Set(["vbk::核查 回民街·钟鼓楼广场 的 VBK POI 映射"]),
  });

  assert.equal(taskWrites.length, 0, "已有任务不重复写入");
  assert.deepEqual(result, []);
});

test("原始 POI 查询失败时不创建未匹配任务", async () => {
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "网络异常景点", poiName: null, poiId: null }] }] },
    suggestPoi: async () => { throw new Error("network"); },
  });
  await enrichItineraryPois({
    localProductId: "query-failed", destination: "西安", runtime, persistedTaskKeys: new Set(),
  });
  assert.equal(runtime.tasks.length, 0);
});

test("POI 写回被拒时不记录为成功，并向调用方返回可处理的失败", async () => {
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: null, poiId: null }] }] },
    suggestPoi: async () => ({ poiName: "晋祠博物馆", poiId: 83199 }),
  });
  runtime.writeModule = async () => ({ ok: false, reason: "数据库暂不可写" });

  await assert.rejects(
    enrichItineraryPois({ localProductId: "poi-write-failed", destination: "太原", runtime, persistedTaskKeys: new Set() }),
    /POI 映射未保存：数据库暂不可写/,
  );
});

function testRuntime(args: {
  product: Record<string, unknown>;
  suggestPoi: (keyword: string, context?: { destinationCity?: string; province?: string }) => Promise<{ poiName: string; poiId: number } | null>;
  write?: (value: any) => void;
}) {
  const tasks: ResearchTaskProposal[] = [];
  return {
    tasks,
    suggestPoi: args.suggestPoi,
    loadExistingResearchTasks: async () => [],
    writeModule: async (_localProductId: string, _module: any, _path: string, value: any) => { args.write?.(value); return { ok: true }; },
    addResearchTask: async (_localProductId: string, task: ResearchTaskProposal) => { tasks.push(task); return task.label; },
    loadHistory: async () => [],
    loadCurrentProduct: async () => args.product,
    loadAcceptedModules: async () => ["itinerary" as const],
  } satisfies OrchestratorRuntime & { tasks: ResearchTaskProposal[] };
}
