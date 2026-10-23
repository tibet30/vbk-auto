import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { ResearchTaskProposal } from "../../src/shared/contracts-planning.js";

test("POI 补全查询携带产品目的城市和省份上下文", async () => {
  const contexts: unknown[] = [];
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "乌鲁木齐", province: "新疆" },
      itinerary: [{ day: 1, spots: [{ name: "南山风景区", poiName: null, poiId: null }] }],
    },
    suggestPoi: async (_keyword, context) => {
      contexts.push(context);
      return { poiName: "乌鲁木齐市南山风景区", poiId: 99101 };
    },
  });

  await enrichItineraryPois({
    localProductId: "poi-context",
    destination: "新疆",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(contexts, [{ destinationCity: "乌鲁木齐", province: "新疆" }]);
});

test("仅有跨城住宿字段不能放宽 POI 查询的接团城市", async () => {
  const contexts: unknown[] = [];
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "拉萨", province: "西藏" },
      itinerary: [
        { day: 1, hotelCity: "日喀则", spots: [{ name: "卡若拉冰川", poiName: null, poiId: null }] },
        { day: 2, hotelCity: "定日", spots: [] },
      ],
    },
    suggestPoi: async (_keyword, context) => {
      contexts.push(context);
      return { poiName: "卡若拉冰川", poiId: 91485 };
    },
  });
  await enrichItineraryPois({ localProductId: "tibet-cross-city", destination: "拉萨", runtime, persistedTaskKeys: new Set() });
  assert.deepEqual(contexts, [{ destinationCity: "拉萨", province: "西藏" }]);
});

test("措错正字差异会查询官方别名并写回原景点槽位", async () => {
  const queries: string[] = [];
  let written: any;
  const runtime = testRuntime({
    product: { basicInfo: { destinationCity: "拉萨", province: "西藏" },
      itinerary: [{ day: 4, title: "公珠措", spots: [{ name: "公珠措", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      return keyword === "公珠错" ? { poiName: "公珠错", poiId: 91992 } : null;
    },
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({ localProductId: "orthographic-alias", destination: "拉萨", runtime, persistedTaskKeys: new Set() });
  assert.deepEqual(queries, ["公珠措", "公珠错"]);
  assert.equal(written[0].spots[0].name, "公珠措");
  assert.equal(written[0].spots[0].poiName, "公珠错");
  assert.equal(written[0].spots[0].poiId, 91992);
});

test("已完整 POI 复核时必须重新查询，正确 ID 可由本次查询确认", async () => {
  let written: any;
  let queryCount = 0;
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "乌鲁木齐", province: "新疆" },
      itinerary: [{ day: 3, spots: [{ name: "南山风景区", poiName: "南山风景区", poiId: 78174 }] }],
    },
    suggestPoi: async () => {
      queryCount += 1;
      return { poiName: "南山风景区", poiId: 78174 };
    },
    write: (value) => { written = value; },
  });

  const result = await enrichItineraryPois({
    localProductId: "poi-stale-context",
    destination: "新疆",
    runtime,
    persistedTaskKeys: new Set(),
    reviewCompletePois: true,
  });

  assert.equal(queryCount, 1);
  assert.equal(written[0].spots[0].poiId, 78174);
  assert.deepEqual(result, []);
});

test("已完整 POI 复核会用独立查询替换同省错 ID", async () => {
  let written: any;
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "乌鲁木齐", province: "新疆" },
      itinerary: [{ day: 3, spots: [{ name: "南山风景区", poiName: "同省错误景点", poiId: 111 }] }],
    },
    suggestPoi: async () => ({ poiName: "南山风景区", poiId: 78174 }),
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    localProductId: "poi-stale-id", destination: "新疆", runtime,
    persistedTaskKeys: new Set(), reviewCompletePois: true,
  });
  assert.equal(written[0].spots[0].poiId, 78174);
  assert.equal(written[0].spots[0].poiName, "南山风景区");
});

test("已绑定但暂停营业的 POI 保留原槽位、清空失效绑定并创建人工任务", async () => {
  let written: any;
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "成都", province: "四川" },
      itinerary: [{ day: 2, spots: [
        { name: "金沙遗址博物馆", poiName: "金沙遗址博物馆", poiId: 12345 },
        { name: "武侯祠", poiName: "武侯祠", poiId: 67890 },
      ] }],
    },
    suggestPoi: async (keyword) => ({ poiName: keyword, poiId: keyword === "金沙遗址博物馆" ? 12345 : 67890 }),
    write: (value) => { written = value; },
  });
  let batchIds: readonly number[] = [];
  runtime.getPoiAvailabilities = async (poiIds) => {
    batchIds = poiIds;
    return new Map(poiIds.map((poiId) => [poiId, { status: poiId === 12345 ? "suspended" as const : "available" as const }]));
  };

  const result = await enrichItineraryPois({
    localProductId: "poi-suspended", destination: "成都", runtime, persistedTaskKeys: new Set(), reviewCompletePois: true,
  });

  assert.deepEqual(written[0].spots, [
    { name: "金沙遗址博物馆", poiName: null, poiId: null },
    { name: "武侯祠", poiName: "武侯祠", poiId: 67890 },
  ]);
  assert.equal(result[0]?.label, "核查 金沙遗址博物馆 的 VBK POI 映射");
  assert.match(result[0]?.detail ?? "", /暂停营业，已清除旧 POI 绑定并保留原行程位置/);
  assert.deepEqual([...new Set(batchIds)].sort(), [12345, 67890]);
});

test("自动匹配到暂停营业 POI 时保留槽位但不保存失效绑定", async () => {
  let written: any;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "金沙遗址博物馆", poiName: null, poiId: null }] }] },
    suggestPoi: async () => ({ poiName: "金沙遗址博物馆", poiId: 82723 }),
    write: (value) => { written = value; },
  });
  runtime.getPoiAvailability = async () => ({ status: "suspended" });

  const result = await enrichItineraryPois({
    localProductId: "poi-suspended-auto", destination: "成都", runtime, persistedTaskKeys: new Set(),
  });

  assert.deepEqual(written[0].spots, [{ name: "金沙遗址博物馆", poiName: null, poiId: null }]);
  assert.match(result[0]?.detail ?? "", /携程景点详情标记为暂停营业/);
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
    writeModule: async (_localProductId: string, _module: any, _path: string, value: any) => {
      args.write?.(value);
      return { ok: true };
    },
    addResearchTask: async (_localProductId: string, task: ResearchTaskProposal) => {
      tasks.push(task);
      return task.label;
    },
    loadHistory: async () => [],
    loadCurrentProduct: async () => args.product,
    loadAcceptedModules: async () => ["itinerary" as const],
  } satisfies OrchestratorRuntime & { tasks: ResearchTaskProposal[] };
}
