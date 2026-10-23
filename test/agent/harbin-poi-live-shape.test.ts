import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { requiresItineraryPoi } from "../../src/shared/itinerary-activity-kind.js";

type Replay = {
  endpoint: string;
  body: { keyword?: string };
  status: number;
  payload: unknown;
};
const records = JSON.parse(
  readFileSync(
    new URL("../fixtures/poi-query-live-shape/records.json", import.meta.url),
    "utf8",
  ),
) as Replay[];
const availability = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/poi-query-live-shape/availability.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Array<{ poiId: number; payload: unknown }>;
const expected = new Map<string, number>([
  ["龙江第一湾", 91861],
  ["中国最北点", 56810159],
  ["乌苏里浅滩", 10541112],
  ["北红村篝火晚会", 10541118],
  ["鄂温克使鹿部落", 71944168],
  ["圣诞村", 18119428],
  ["北极村", 86672],
  ["北极星广场", 18456561],
  ["松苑公园", 86679],
  ["五·六火灾纪念馆", 86682],
  ["漠河舞厅", 136063426],
]);
const raw =
  "Day1 出发地-哈尔滨市\nDay2 漠河接站-龙江第一湾-中国最北点-乌苏里浅滩-北红村篝火晚会\nDay3 泼水成冰-马拉爬犁-鄂温克使鹿部落-圣诞村-滑雪2小时-北极村\nDay4 北极星广场-松苑公园-五·六火灾纪念馆-漠河舞厅";

test("真实回放从空白产品生成、匹配、保存回读并保留人工删除", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vbk-live-poi-shape-"));
  const originalFetch = globalThis.fetch;
  let db = new VbkDatabase(directory);
  const misses: string[] = [];
  try {
    const created = db.createProduct({
      destination: "哈尔滨",
      days: 4,
      productForm: "privateTour",
      userIdea: raw,
    });
    db.updateProduct(created.id, {
      ...created.product,
      basicInfo: {
        ...created.product.basicInfo,
        province: "黑龙江",
        subtitle: "漠河原路线",
        operationNotes: "按用户原路线",
      },
      operations: {
        ...created.product.operations,
        pickupCity: "哈尔滨",
        trafficLine: { enabled: false, variants: [] },
      },
    });
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const poiId = Number(JSON.parse(String(init?.body ?? "{}")).poiId);
      const replay = availability.find((item) => item.poiId === poiId);
      if (!url.includes("getSightOnlinePage") || !replay) {
        misses.push(`fetch:${url}:${poiId}`);
        throw new Error(`缺少公开营业状态回放：${poiId}`);
      }
      return new Response(JSON.stringify(replay.payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const used = new Set<string>();
    const page = {
      nativeOnly: true,
      vbkSessionFetch: async (request: {
        endpoint: string;
        body: { keyword?: string };
      }) => {
        const endpoint = new URL(request.endpoint).pathname;
        const keyword = String(request.body.keyword ?? "");
        const replay = records.find(
          (item) => item.endpoint === endpoint && item.body.keyword === keyword,
        );
        if (!replay) {
          misses.push(`${endpoint}:${keyword}`);
          throw new Error(`缺少原始查询回放：${endpoint} ${keyword}`);
        }
        used.add(`${endpoint}:${keyword}`);
        return {
          status: replay.status,
          payload: structuredClone(replay.payload),
        };
      },
    };
    const mutations = new ProductMutationService(db);
    const tools = createAgentBusinessTools({
      db,
      browser: { requestPage: async () => page } as never,
      automation: {} as never,
      productMutations: mutations,
      productWorkflows: exclusive as never,
      generateStage: async () => {
        throw new Error("完整原路线必须由 production projection 生成");
      },
      disambiguatePoiOption: async ({ desired, candidates }) => {
        const targetId = expected.get(desired);
        assert.ok(targetId, `未知消歧关键词 ${desired}`);
        const target = candidates.find(
          (item) => item.id === String(candidateIds(desired).indexOf(targetId)),
        );
        assert.ok(
          target &&
            target.text.includes("黑龙江") &&
            target.text.includes("大兴安岭"),
          `${desired} 必须在真实同地域候选中选择目标`,
        );
        return { pickedText: target.text, confidence: 0.99 };
      },
      disambiguateStationOption: async () => ({
        pickedText: null,
        reasoning: "",
      }),
      emitProduct: () => undefined,
    });
    const context = {
      localProductId: created.id,
      accountKey: "test",
      productVersion: "test",
    };
    const generated = await tools
      .find((tool) => tool.name === "generate_product_module")!
      .execute({ stage: "itinerary" }, context);
    assert.notEqual(generated.data?.preparationDenied, true, generated.content);
    for (const name of expected.keys())
      db.addResearchTask(created.id, {
        type: "vbk",
        label: `核查 ${name} 的 VBK POI 映射`,
        detail: "等待真实候选核验",
      });
    for (let attempt = 0; attempt < 3; attempt += 1)
      await tools
        .find((tool) => tool.name === "resolve_itinerary_pois")!
        .execute({}, context);
    const reader = new VbkDatabase(directory);
    const saved = reader.getProduct(created.id)!;
    reader.close();
    const spots = saved.product.itinerary!.flatMap((day) => day.spots ?? []);
    const attractions = spots.filter(requiresItineraryPoi);
    assert.deepEqual(
      attractions.map((spot) => spot.name),
      [...expected.keys()],
    );
    assert.deepEqual(
      attractions.map((spot) => spot.poiId),
      [...expected.values()],
    );
    assert.deepEqual(
      spots.filter((spot) => spot.kind === "other").map((spot) => spot.name),
      ["泼水成冰", "马拉爬犁", "滑雪2小时"],
    );
    assert.equal(
      saved.researchTasks.filter(
        (task) => task.type === "vbk" && task.state !== "confirmed",
      ).length,
      0,
    );
    assert.deepEqual(misses, [], "所有远端/公开请求必须有固定回放收据");
    const dayIndex = saved.product.itinerary!.findIndex((day) => day.day === 2);
    const spotIndex = saved.product.itinerary![dayIndex]!.spots!.findIndex(
      (spot) => spot.name === "北红村篝火晚会",
    );
    mutations.commands.manualField(
      {
        localProductId: created.id,
        source: "user",
        expectedVersion: db.getProduct(created.id)!.productJsonVersion ?? 0,
      },
      { field: "itinerarySpotRemove", dayIndex, spotIndex },
    );
    used.clear();
    await tools
      .find((tool) => tool.name === "resolve_itinerary_pois")!
      .execute({}, context);
    const finalReader = new VbkDatabase(directory);
    const finalProduct = finalReader.getProduct(created.id)!;
    finalReader.close();
    assert.ok(
      !finalProduct.product.itinerary![dayIndex]!.spots!.some(
        (spot) => spot.name === "北红村篝火晚会",
      ),
    );
    assert.ok(
      ![...used].some(
        (key) => key.endsWith(":北红村篝火晚会") || key.endsWith(":北红村"),
      ),
    );
    assert.deepEqual(misses, [], "复核不得吞掉任何缺失回放");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function candidateIds(keyword: string): number[] {
  const record = records.find(
    (item) =>
      item.endpoint.endsWith("suggestPoi") && item.body.keyword === keyword,
  );
  return (
    (record?.payload as { poiList?: Array<{ poiId?: number }> }).poiList ?? []
  ).map((item) => Number(item.poiId));
}
const exclusive = {
  runExclusive: async (
    _id: string,
    _kind: string,
    work: () => Promise<unknown>,
  ) => work(),
  runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
};
