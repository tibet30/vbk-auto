import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { ResearchTaskProposal } from "../../src/shared/contracts-planning.js";

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
    writeModule: async (_projectId, module, path, value) => {
      assert.equal(module, "itinerary");
      assert.equal(path, AI_WRITABLE_PATHS.itinerary);
      written = value;
      return { ok: true };
    },
    addResearchTask: async (_projectId, task) => {
      if (!tasks.some((item) => item.type === task.type && item.label === task.label)) tasks.push(task);
      return task.label;
    },
    loadHistory: async () => [],
    loadCurrentProduct: async () => product,
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    projectId: "poi-timeout",
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
    addResearchTask: async (_projectId, task) => {
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
    projectId: "poi-no-match",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(tasks, [{
    label: "核查 晋祠 的 VBK POI 映射",
    type: "vbk",
    detail: "suggestPoi 未匹配，请人工核查",
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
    projectId: "poi-existing-no-match",
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
    projectId: "poi-only-missing",
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
    projectId: "poi-complete",
    destination: "太原",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.equal(queries, 0);
  assert.equal(writes, 0);
});

test("原始名称未命中后，第二个 AI 单点候选命中会写回原 spot", async () => {
  const queries: string[] = [];
  const resolverAttempts: number[] = [];
  let written: any;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      return keyword === "西安钟楼" ? { poiName: "西安钟楼", poiId: 123 } : null;
    },
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    projectId: "fallback-success", destination: "西安", runtime, persistedTaskKeys: new Set(),
    resolvePoiName: async ({ attempt }) => {
      resolverAttempts.push(attempt);
      return attempt === 1 ? "回民街" : "西安钟楼";
    },
  });
  assert.deepEqual(queries, ["回民街·钟鼓楼广场", "回民街", "西安钟楼"]);
  assert.deepEqual(resolverAttempts, [1, 2]);
  assert.deepEqual(written[0].spots[0], { name: "回民街·钟鼓楼广场", poiName: "西安钟楼", poiId: 123 });
  assert.equal(runtime.tasks.length, 0);
});

test("原始名称直接命中不调用 AI；第三个候选也可正常写回", async () => {
  let resolverCalls = 0;
  const directRuntime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "西安钟楼", poiName: null, poiId: null }] }] },
    suggestPoi: async () => ({ poiName: "西安钟楼", poiId: 1 }),
  });
  await enrichItineraryPois({
    projectId: "fallback-direct", destination: "西安", runtime: directRuntime, persistedTaskKeys: new Set(),
    resolvePoiName: async () => { resolverCalls += 1; return "不应调用"; },
  });
  assert.equal(resolverCalls, 0);

  let written: any;
  const thirdRuntime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => keyword === "西安鼓楼" ? { poiName: "西安鼓楼", poiId: 2 } : null,
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    projectId: "fallback-third", destination: "西安", runtime: thirdRuntime, persistedTaskKeys: new Set(),
    resolvePoiName: async ({ attempt }) => ["回民街", "西安钟楼", "西安鼓楼"][attempt - 1],
  });
  assert.deepEqual(written[0].spots[0], { name: "回民街·钟鼓楼广场", poiName: "西安鼓楼", poiId: 2 });
});

test("三次 AI 仍无候选时只创建一条带次数的人工核查项", async () => {
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async () => null,
  });
  const result = await enrichItineraryPois({
    projectId: "fallback-exhausted", destination: "西安", runtime, persistedTaskKeys: new Set(),
    resolvePoiName: async ({ attempt }) => `西安候选${attempt}`,
  });
  assert.equal(runtime.tasks.length, 1);
  assert.match(runtime.tasks[0].detail ?? "", /3 次 AI 名称纠正仍未匹配/);
  assert.deepEqual(result, runtime.tasks);
});

test("AI 重复已查询候选不会再次请求 VBK", async () => {
  const queries: string[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => { queries.push(keyword); return null; },
  });
  const seenRequests: any[] = [];
  await enrichItineraryPois({
    projectId: "fallback-deduped", destination: "西安", runtime, persistedTaskKeys: new Set(),
    resolvePoiName: async (request) => {
      seenRequests.push(request);
      return request.attempt === 1 ? "回民街" : "回民街";
    },
  });
  assert.deepEqual(queries, ["回民街·钟鼓楼广场", "回民街"]);
  assert.deepEqual(seenRequests[1].previousCandidates, ["回民街"]);
});

test("三次 AI 耗尽会升级已有 canonical 核查项详情，但不报告为新增", async () => {
  const taskWrites: ResearchTaskProposal[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async () => null,
  });
  runtime.addResearchTask = async (_projectId, task) => {
    taskWrites.push(task);
    return "existing-task";
  };

  const result = await enrichItineraryPois({
    projectId: "fallback-existing-exhausted", destination: "西安", runtime,
    persistedTaskKeys: new Set(["vbk::核查 回民街·钟鼓楼广场 的 VBK POI 映射"]),
    resolvePoiName: async ({ attempt }) => `西安候选${attempt}`,
  });

  assert.equal(taskWrites.length, 1, "已有任务仅更新详情，不新增数据库记录");
  assert.match(taskWrites[0].detail ?? "", /3 次 AI 名称纠正仍未匹配/);
  assert.deepEqual(result, []);
});

test("相同或组合 AI 候选被拒绝但仍计入三次，绝不查询或猜测 ID", async () => {
  const queries: string[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => { queries.push(keyword); return null; },
  });
  await enrichItineraryPois({
    projectId: "fallback-invalid", destination: "西安", runtime, persistedTaskKeys: new Set(),
    resolvePoiName: async ({ attempt }) => ["回民街·钟鼓楼广场", "钟楼和鼓楼", "钟楼与鼓楼"][attempt - 1],
  });
  assert.deepEqual(queries, ["回民街·钟鼓楼广场"]);
  assert.match(runtime.tasks[0].detail ?? "", /3 次 AI 名称纠正仍未匹配/);
});

test("原始 POI 查询失败不调用 AI，也不创建未匹配任务", async () => {
  let resolverCalls = 0;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "网络异常景点", poiName: null, poiId: null }] }] },
    suggestPoi: async () => { throw new Error("network"); },
  });
  await enrichItineraryPois({
    projectId: "fallback-query-failed", destination: "西安", runtime, persistedTaskKeys: new Set(),
    resolvePoiName: async () => { resolverCalls += 1; return "西安钟楼"; },
  });
  assert.equal(resolverCalls, 0);
  assert.equal(runtime.tasks.length, 0);
});

function testRuntime(args: {
  product: Record<string, unknown>;
  suggestPoi: (keyword: string) => Promise<{ poiName: string; poiId: number } | null>;
  write?: (value: any) => void;
}) {
  const tasks: ResearchTaskProposal[] = [];
  return {
    tasks,
    suggestPoi: args.suggestPoi,
    loadExistingResearchTasks: async () => [],
    writeModule: async (_projectId: string, _module: any, _path: string, value: any) => { args.write?.(value); return { ok: true }; },
    addResearchTask: async (_projectId: string, task: ResearchTaskProposal) => { tasks.push(task); return task.label; },
    loadHistory: async () => [],
    loadCurrentProduct: async () => args.product,
    loadAcceptedModules: async () => ["itinerary" as const],
  } satisfies OrchestratorRuntime & { tasks: ResearchTaskProposal[] };
}
