import test from "node:test";
import assert from "node:assert/strict";
import { ensurePricingInventoryApi } from "../../src/main/automation/ctrip/pricing-api.js";
import {
  VBK_ASYNC_REQUEST_ACCEPTED_ERROR_CODE,
  VBK_GROUP_DAILY_REQUEST_INTERVAL_MS,
  assertGroupAgeBandConfig,
  assertGroupPricingReadback,
  buildGroupPricingExpectation,
  classifyPricingResponse,
  retryBusyGroupRequest,
} from "../../src/main/automation/ctrip/pricing-group-contract.js";

const success = { ResponseStatus: { Ack: "Success", Errors: [] } };
const ageBands = [
  {
    ageBandId: 11,
    ageBandCode: "ADULT",
    tiers: [
      { tierId: 101, tierCode: "INCOMPLETE_GROUP", minPassengersRequired: 1, maxPassengersRequired: 7 },
      { tierId: 102, tierCode: "COMPLETED_GROUP", minPassengersRequired: 8, maxPassengersRequired: 8 },
    ],
  },
  {
    ageBandId: 22,
    ageBandCode: "CHILD",
    tiers: [
      { tierId: 201, tierCode: "INCOMPLETE_GROUP", minPassengersRequired: 1, maxPassengersRequired: 7 },
      { tierId: 202, tierCode: "COMPLETED_GROUP", minPassengersRequired: 8, maxPassengersRequired: 8 },
    ],
  },
];
const product = {
  commercial: {
    pricing: { adult: 1_000, child: 600 },
    inventory: { startDate: "2026-09-01", endDate: "2026-09-02", dailyQuota: 8 },
  },
  sales: { splitGroup: true, maxGroupSize: 8 },
};

type BrowserCall = { path: string; body: any };

function browserWithHandler(handler: (path: string, body: any, calls: BrowserCall[]) => any) {
  const calls: BrowserCall[] = [];
  return {
    calls,
    async evaluate(_fn: unknown, args: { endpoint: string; body: any }) {
      const path = new URL(args.endpoint).pathname.split("/").pop() ?? "";
      calls.push({ path, body: args.body });
      const payload = await handler(path, args.body, calls);
      return { status: 200, payload, durationMs: 1, ctx: {} };
    },
  };
}

function rowFromSaveBody(body: any) {
  const inventory = body.singleResourceUnitPriceInventory.singleResourceInventoryVO;
  const units = body.singleResourceUnitPriceInventory.singleResourceUnitPriceDtos;
  return {
    productDate: units[0].date,
    inventory: { total: inventory.total },
    singleResourceUnitPriceDtos: units,
  };
}

function baseEndpointPayload(path: string) {
  if (path === "getPackageList") {
    return {
      ...success,
      itemList: [{
        singleResourceId: 7001,
        optionalResourceId: 8001,
        childOccupationBedResourceId: 9001,
        priceInputType: 5,
        isHotelResource: "F",
      }],
    };
  }
  if (path === "saveAgeBandConfig") return { ...success, resourceId: 7001 };
  if (path === "queryAgeBandConfig") return { ...success, ageBands };
  return null;
}

test("缺失 cost 时按 queryAgeBandConfig 的实际 ID 生成有限价格，并逐日串行重试", async () => {
  const acceptedRows: any[] = [];
  let readCount = 0;
  let firstDateAttempts = 0;
  const browser = browserWithHandler((path, body) => {
    const base = baseEndpointPayload(path);
    if (base) return base;
    if (path === "GetBatchOperateSchedule") {
      readCount += 1;
      return { ...success, dates: readCount === 1 ? [] : acceptedRows };
    }
    if (path === "savePriceInventorySingleProduct") {
      const date = body.dateChoose.dates[0];
      if (date === "2026-09-01" && firstDateAttempts++ === 0) {
        return {
          ResponseStatus: {
            Ack: "Failure",
            Errors: [{ ErrorCode: VBK_ASYNC_REQUEST_ACCEPTED_ERROR_CODE, Message: "请求已经提交" }],
          },
        };
      }
      acceptedRows.push(rowFromSaveBody(body));
      return success;
    }
    throw new Error(`unexpected endpoint: ${path}`);
  });
  const pauses: number[] = [];

  const result = await ensurePricingInventoryApi(browser as never, product, "123", {
    pause: async (milliseconds) => { pauses.push(milliseconds); },
  });

  const saves = browser.calls.filter((call) => call.path === "savePriceInventorySingleProduct");
  assert.deepEqual(saves.map((call) => call.body.dateChoose.dates), [
    ["2026-09-01"],
    ["2026-09-01"],
    ["2026-09-02"],
  ]);
  assert.deepEqual(pauses, [VBK_GROUP_DAILY_REQUEST_INTERVAL_MS, VBK_GROUP_DAILY_REQUEST_INTERVAL_MS]);
  assert.equal(result.dateCount, 2);

  const firstAccepted = saves[1].body.singleResourceUnitPriceInventory;
  assert.deepEqual(firstAccepted.singleResourceInventoryVO, {
    adultCostPrice: 1_000,
    adultSalePrice: 1_000,
    chdCostPrice: 600,
    chdSalePrice: 600,
    isLimit: "T",
    isExceed: "F",
    total: 8,
  });
  assert.deepEqual(
    firstAccepted.singleResourceUnitPriceDtos.map((unit: any) => ({
      key: `${unit.unitInfo.ageBandId}/${unit.unitInfo.tierId}`,
      cost: unit.costPrice,
      sale: unit.salePrice,
    })),
    [
      { key: "11/101", cost: 1_000, sale: 1_000 },
      { key: "11/102", cost: 970, sale: 970 },
      { key: "22/201", cost: 600, sale: 600 },
      { key: "22/202", cost: 582, sale: 582 },
    ],
  );
  assert.ok(firstAccepted.singleResourceUnitPriceDtos.every((unit: any) => (
    Number.isFinite(unit.costPrice) && unit.costPrice > 0
    && Number.isFinite(unit.salePrice) && unit.salePrice > 0
  )));
});

test("已有四层但任一价格错误时不会跳过该日期，而会精确重提", async () => {
  const expectation = buildGroupPricingExpectation(ageBands, product.commercial.pricing, 8);
  const wrongExistingRow = {
    productDate: "2026-09-01",
    inventory: { total: 8 },
    singleResourceUnitPriceDtos: expectation.units.map((unit, index) => ({
      date: "2026-09-01",
      costPrice: index === 2 ? 0 : unit.costPrice,
      salePrice: unit.salePrice,
      unitInfo: { ageBandId: unit.ageBandId, tierId: unit.tierId },
    })),
  };
  const acceptedRows: any[] = [];
  let readCount = 0;
  const browser = browserWithHandler((path, body) => {
    const base = baseEndpointPayload(path);
    if (base) return base;
    if (path === "GetBatchOperateSchedule") {
      readCount += 1;
      return { ...success, dates: readCount === 1 ? [wrongExistingRow] : acceptedRows };
    }
    if (path === "savePriceInventorySingleProduct") {
      acceptedRows.push(rowFromSaveBody(body));
      return success;
    }
    throw new Error(`unexpected endpoint: ${path}`);
  });

  await ensurePricingInventoryApi(browser as never, product, "123", { pause: async () => {} });
  assert.deepEqual(
    browser.calls.filter((call) => call.path === "savePriceInventorySingleProduct")
      .map((call) => call.body.dateChoose.dates[0]),
    ["2026-09-01", "2026-09-02"],
  );
});

test("queryAgeBandConfig 必须逐年龄段精确回读两档区间，缺失或重复组合直接失败", async () => {
  const wrongRange = structuredClone(ageBands);
  wrongRange[1].tiers[0].maxPassengersRequired = 8;
  const browser = browserWithHandler((path) => {
    if (path === "queryAgeBandConfig") return { ...success, ageBands: wrongRange };
    const base = baseEndpointPayload(path);
    if (base) return base;
    throw new Error(`unexpected endpoint: ${path}`);
  });
  await assert.rejects(
    ensurePricingInventoryApi(browser as never, product, "123", { pause: async () => {} }),
    /CHILD 成团区间回读不一致.*1-7、8-8/,
  );
  assert.equal(browser.calls.some((call) => call.path === "savePriceInventorySingleProduct"), false);

  const missingTier = structuredClone(ageBands);
  missingTier[0].tiers.pop();
  assert.throws(() => assertGroupAgeBandConfig(missingTier, 8), /必须恰好包含两个价格层级/);
  assert.throws(() => assertGroupAgeBandConfig([ageBands[0]], 8), /同时包含 ADULT 和 CHILD/);
  const duplicateTier = structuredClone(ageBands);
  duplicateTier[0].tiers[1].tierCode = "INCOMPLETE_GROUP";
  assert.throws(() => assertGroupAgeBandConfig(duplicateTier, 8), /年龄段\/层级重复/);
});

test("远端回读逐日期精确核对 ID、层级价格和库存", () => {
  const expectation = buildGroupPricingExpectation(ageBands, product.commercial.pricing, 8);
  const makeRow = () => ({
    productDate: "2026-09-01",
    inventory: { total: 8 },
    singleResourceUnitPriceDtos: expectation.units.map((unit) => ({
      date: "2026-09-01",
      costPrice: unit.costPrice,
      salePrice: unit.salePrice,
      unitInfo: { ageBandId: unit.ageBandId, tierId: unit.tierId },
    })),
  });
  assert.doesNotThrow(() => assertGroupPricingReadback([makeRow()], ["2026-09-01"], expectation));

  const mutations: Array<[string, (row: any) => void]> = [
    ["缺层级", (row) => { row.singleResourceUnitPriceDtos.pop(); }],
    ["错年龄段 ID", (row) => { row.singleResourceUnitPriceDtos[0].unitInfo.ageBandId = 999; }],
    ["零成本价", (row) => { row.singleResourceUnitPriceDtos[0].costPrice = 0; }],
    ["错销售价", (row) => { row.singleResourceUnitPriceDtos[1].salePrice += 1; }],
    ["错库存", (row) => { row.inventory.total = 7; }],
  ];
  for (const [label, mutate] of mutations) {
    const row = makeRow();
    mutate(row);
    assert.throws(
      () => assertGroupPricingReadback([row], ["2026-09-01"], expectation),
      /回读不一致/,
      label,
    );
  }
});

test("平台明确标记自动卖价时，保留成本与库存精确核对但接受平台计算卖价", () => {
  const expectation = buildGroupPricingExpectation(ageBands, product.commercial.pricing, 8);
  const row = {
    base: { productDate: "2026-09-01" },
    inventory: { total: 8 },
    adultPrice: { salePriceStatus: "Auto" },
    childPrice: { salePriceStatus: "Auto" },
    singleResourceUnitPriceDtos: expectation.units.map((unit, index) => ({
      date: "2026-09-01",
      costPrice: unit.costPrice,
      salePrice: unit.salePrice - (index + 1),
      unitInfo: { ageBandId: unit.ageBandId, tierId: unit.tierId },
    })),
  };
  assert.doesNotThrow(() => assertGroupPricingReadback([row], ["2026-09-01"], expectation));

  row.singleResourceUnitPriceDtos[0].costPrice = 0;
  assert.throws(() => assertGroupPricingReadback([row], ["2026-09-01"], expectation), /回读不一致/);
});

test("只有结构化 20018030 会重试；错误消息中的同码文本不会触发兼容", async () => {
  let busyCalls = 0;
  const pauses: number[] = [];
  const payload = await retryBusyGroupRequest(
    async () => ({
      payload: busyCalls++ === 0
        ? { ResponseStatus: { Ack: "Failure", Errors: [{ ErrorCode: "20018030" }] } }
        : success,
    }),
    async (milliseconds) => { pauses.push(milliseconds); },
    "保存",
  );
  assert.equal(payload, success);
  assert.equal(busyCalls, 2);
  assert.deepEqual(pauses, [VBK_GROUP_DAILY_REQUEST_INTERVAL_MS]);

  let messageOnlyCalls = 0;
  await assert.rejects(
    retryBusyGroupRequest(
      async () => {
        messageOnlyCalls += 1;
        return { payload: { ResponseStatus: { Ack: "Failure", Errors: [{ Message: "ErrorCode 20018030" }] } } };
      },
      async () => { throw new Error("不应等待"); },
      "保存",
    ),
    /保存失败/,
  );
  assert.equal(messageOnlyCalls, 1);
  assert.equal(classifyPricingResponse({
    ResponseStatus: { Ack: "Failure", Errors: [{ ErrorCode: "20018030" }, { ErrorCode: "OTHER" }] },
  }).kind, "failure");
});

test("最终月回读价格为零时整次保存失败", async () => {
  const acceptedRows: any[] = [];
  let readCount = 0;
  const browser = browserWithHandler((path, body) => {
    const base = baseEndpointPayload(path);
    if (base) return base;
    if (path === "GetBatchOperateSchedule") {
      readCount += 1;
      if (readCount === 1) return { ...success, dates: [] };
      const wrongRows = structuredClone(acceptedRows);
      wrongRows[1].singleResourceUnitPriceDtos[3].salePrice = 0;
      return { ...success, dates: wrongRows };
    }
    if (path === "savePriceInventorySingleProduct") {
      acceptedRows.push(rowFromSaveBody(body));
      return success;
    }
    throw new Error(`unexpected endpoint: ${path}`);
  });

  await assert.rejects(
    ensurePricingInventoryApi(browser as never, product, "123", { pause: async () => {} }),
    /1\/2 个日期精确匹配.*2026-09-02/,
  );
});
