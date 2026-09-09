import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTrafficLineClauseSaveRequest,
  clauseRequirementsByIds,
  desiredFirstTabClauses,
  ensureTrafficLineClauses,
  resolveChildTransportClauseRequirements,
  selectedClauseItems,
  waitForTrafficLineClausePackage,
} from "../../src/main/automation/ctrip/traffic-line/clauses.ts";
import {
  manualRequiredClauseIdsByTab,
  readManualRequiredClauses,
} from "../../src/main/automation/ctrip/traffic-line/clause-required.ts";
import {
  TrafficLineClauseReadbackError,
  verifyTrafficLineClauses,
} from "../../src/main/automation/ctrip/traffic-line/clause-readback.ts";
import { TrafficLineItineraryReadbackError } from "../../src/main/automation/ctrip/traffic-line/readback.ts";
import { isTrafficLineClauseActivationError } from "../../src/main/automation/ctrip/traffic-line/readback.ts";

test("飞机子产品沿用平台自动生成的去返程条款，不注入母产品 3035", () => {
  const schema = childClauseSchema("flightRoundTrip");
  const existing = [
    ...selectedClauseItems(schema),
    { clauseItemId: 10081, secondClassTypeId: 86, elementDtos: [] },
    { clauseItemId: 33006, secondClassTypeId: 316, elementDtos: [{ componentCode: "stale", value: "旧值" }] },
  ];
  const desired = desiredFirstTabClauses(schema, existing, "flightRoundTrip");
  assert.deepEqual(desired.map((item) => item.clauseItemId), [38725, 38739, 33006]);
  assert.equal(desired.some((item) => item.clauseItemId === 3035), false);
  assert.deepEqual(desired.find((item) => item.clauseItemId === 33006)?.elementDtos, [
    { componentCode: "live-transfer", value: "目的地接送" },
  ]);
});

test("火车子产品保留自动去返程与儿童票说明，并移除遗留飞机主条款", () => {
  const schema = childClauseSchema("trainRoundTrip");
  const existing = [
    ...selectedClauseItems(schema),
    { clauseItemId: 3035, secondClassTypeId: 86, elementDtos: [] },
  ];
  const once = desiredFirstTabClauses(schema, existing, "trainRoundTrip");
  const twice = desiredFirstTabClauses(schema, once, "trainRoundTrip");
  assert.deepEqual(twice, once);
  assert.deepEqual(once.map((item) => item.clauseItemId), [38725, 38739, 10071, 33006]);
  assert.equal(once.some((item) => item.clauseItemId === 10081), false);
});

test("平台未生成或重复生成交通方向条款时在保存前安全阻断", () => {
  assert.throws(
    () => resolveChildTransportClauseRequirements({ clauseTypeDtos: [] }, "flightRoundTrip"),
    /去程项（候选 0 项）/,
  );
  const duplicate = childClauseSchema("flightRoundTrip");
  duplicate.clauseTypeDtos[0]!.clauseItemDtos.push({
    clauseItemId: 40001,
    selected: "T",
    clauseComponentDtos: [{ componentCode: "duplicate", value: "去程补充机票" }],
  });
  assert.throws(
    () => resolveChildTransportClauseRequirements(duplicate, "flightRoundTrip"),
    /去程项（候选 2 项）/,
  );
});

test("交通方向条款使用容器 selectedClauseItemId 时仍能识别去返程", () => {
  const schema = childClauseSchema("flightRoundTrip");
  const traffic = schema.clauseTypeDtos[0]!;
  const [outbound, returning] = traffic.clauseItemDtos;
  delete outbound!.selected;
  delete returning!.selected;
  traffic.clauseItemDtos = [];
  traffic.containers = [
    { selectedClauseItemId: outbound!.clauseItemId, clauseItemDtos: [outbound!] },
    { selectedClauseItemId: returning!.clauseItemId, clauseItemDtos: [returning!] },
  ];

  assert.deepEqual(
    resolveChildTransportClauseRequirements(schema, "flightRoundTrip").map((item) => item.clauseItemId),
    [38725, 38739],
  );
});

test("资源提交后条款 schema 延迟物化时只读等待，不会提前保存不完整条款", async () => {
  const ready = childClauseSchema("flightRoundTrip");
  const responses = [{ clauseTypeDtos: [] }, { clauseTypeDtos: [] }, ready];
  let reads = 0;
  const result = await waitForTrafficLineClausePackage(async () => {
    const response = responses[Math.min(reads, responses.length - 1)]!;
    reads += 1;
    return response;
  }, "flightRoundTrip", { intervalMs: 0, sleep: async () => undefined });
  assert.equal(result, ready);
  assert.equal(reads, 3);
});

test("条款方向出现重复候选时不等待并立即阻断", async () => {
  const duplicate = childClauseSchema("flightRoundTrip");
  duplicate.clauseTypeDtos[0]!.clauseItemDtos.push({
    clauseItemId: 40001,
    selected: "T",
    clauseComponentDtos: [{ componentCode: "duplicate", value: "去程补充机票" }],
  });
  let reads = 0;
  await assert.rejects(() => waitForTrafficLineClausePackage(async () => {
    reads += 1;
    return duplicate;
  }, "flightRoundTrip", { intervalMs: 0, sleep: async () => undefined }), /候选 2 项/);
  assert.equal(reads, 1);
});

test("交通子产品条款保存请求使用页面实测的 isTra=T 上下文", () => {
  const request = buildTrafficLineClauseSaveRequest({
    clausePackageId: 202654973,
    additionalInfoDto: { firstClassTypeIds: [62], isTra: "F" },
    filterConditionDto: { productId: 77985621, pICategoryId: 1003 },
  }, [{ clauseItemId: 38725, secondClassTypeId: 86, elementDtos: [] }]);
  assert.equal((request.additionalInfoDto as any).isTra, "T");
  assert.equal((request.requestBaseData as any).locale, "zh-CN");
  assert.deepEqual(request.firstClassClauseTypeIds, [62]);
  assert.equal(request.pICategoryId, 1003);
  assert.deepEqual(JSON.parse(decodeURIComponent(String(request.businessData))), {
    productId: 77985621,
    from: "vbk",
  });
  assert.equal((request.head as any).cid, "");
});

test("平台返回的手动必选条款按页签去重，并从实时 schema 生成保存 DTO", () => {
  const required = manualRequiredClauseIdsByTab({ manualSaveClauseTipDtos: [
    { tabNum: 4, clauseItemIds: [1153, 1153] },
    { tabNum: 1, clauseItemIds: [33006] },
  ] });
  assert.deepEqual([...required], [[4, [1153]], [1, [33006]]]);
  const schema = {
    clauseTypeDtos: [{
      clauseTypeId: 21,
      containers: [{ clauseItemDtos: [{
        clauseItemId: 1153,
        selected: "F",
        clauseComponentDtos: [{ componentCode: "tourlimit9", value: "1" }],
      }] }],
    }],
  };
  assert.deepEqual(clauseRequirementsByIds(schema, [1153], 4), [{
    clauseItemId: 1153,
    secondClassTypeId: 21,
    elementDtos: [{ componentCode: "tourlimit9", value: "1" }],
  }]);
  assert.throws(() => clauseRequirementsByIds(schema, [999], 4), /无法唯一确认平台必选条款 999/);
});

test("正式回读后才出现的必选条款会进入第二轮保存并最终收敛", async () => {
  const mock = clauseApiMock({ lateRequiredOnce: true });
  const result = await ensureTrafficLineClauses(mock.page, "77990001", "flightRoundTrip");
  assert.deepEqual(result, { tabs: 4, itemCount: 1 });
  assert.equal(mock.autoSaveCalls(), 5);
  assert.equal(mock.savedIds(4).includes(1153), true);
  assert.equal(mock.saveCalls(4), 2);
});

test("必选条款成功响应暂未物化提示数组时只做有界同步重读", async () => {
  const mock = clauseApiMock({ omitFirstAutoResponse: true });
  assert.deepEqual(await readManualRequiredClauses(mock.page, "77990001", {
    sleep: async () => {},
  }), new Map());
  assert.equal(mock.autoSaveCalls(), 2);
});

test("必选条款连续只返回成功状态时交由正式包与激活门继续判定", async () => {
  const mock = clauseApiMock({ omitEveryAutoResponse: true });
  assert.deepEqual(await readManualRequiredClauses(mock.page, "77990001", {
    sleep: async () => {},
  }), new Map());
  assert.equal(mock.autoSaveCalls(), 3);
});

test("第二轮正式回读后必选条款仍未收敛时拒绝完成", async () => {
  const mock = clauseApiMock({ persistentLateRequired: true });
  await assert.rejects(
    () => ensureTrafficLineClauses(mock.page, "77990001", "flightRoundTrip"),
    /两轮保存后仍未收敛.*1153/,
  );
  assert.equal(mock.saveCalls(4), 2);
});

test("最终条款回读拒绝仍有平台必选项的已有效子产品", async () => {
  const mock = clauseApiMock({ pendingOnEveryProbe: true, preloaded: true });
  await assert.rejects(
    () => verifyTrafficLineClauses(mock.page, "77990001", "flightRoundTrip"),
    (error: unknown) => error instanceof TrafficLineClauseReadbackError && /页签 4=1153/.test(error.message),
  );
});

test("最终条款回读同时核对四页绑定包与正式条款 ID", async () => {
  const mock = clauseApiMock({ preloaded: true });
  assert.deepEqual(
    await verifyTrafficLineClauses(mock.page, "77990001", "flightRoundTrip"),
    { formalClauseCount: 4, expectedClauseCount: 4 },
  );
});

test("必选条款响应缺字段或畸形提示时严格失败，不按空列表放行", () => {
  assert.throws(() => manualRequiredClauseIdsByTab({}), /缺少 manualSaveClauseTipDtos/);
  assert.throws(() => manualRequiredClauseIdsByTab({ manualSaveClauseTipDtos: [{}] }), /无法解析/);
  assert.throws(() => manualRequiredClauseIdsByTab({
    manualSaveClauseTipDtos: [{ tabNum: 4, clauseItemIds: [] }],
  }), /非法页签或条款 ID/);
});

test("只有明确条款业务拒绝才允许有界重试激活", () => {
  assert.equal(isTrafficLineClauseActivationError(new Error("Ack=Failure：20019014:必选条款有更新")), true);
  assert.equal(isTrafficLineClauseActivationError(new Error("必选条款未保存")), true);
  assert.equal(isTrafficLineClauseActivationError(new Error("BrowserView 执行超时")), false);
  assert.equal(isTrafficLineClauseActivationError(new Error("Ack=Failure：库存错误")), false);
});

test("行程回读缺交通节点使用独立错误类型，不会与条款或会话错误混淆", () => {
  const error = new TrafficLineItineraryReadbackError("缺少首末交通节点");
  assert.equal(error instanceof TrafficLineItineraryReadbackError, true);
  assert.equal(error instanceof TrafficLineClauseReadbackError, false);
  assert.equal(error.name, "TrafficLineItineraryReadbackError");
});

function childClauseSchema(variant: "flightRoundTrip" | "trainRoundTrip") {
  const mode = variant === "flightRoundTrip" ? "机票（已含机建、燃油税）" : "火车票(G/C高铁/D动车)";
  const traffic = [
    { clauseItemId: 38725, selected: "T", clauseComponentDtos: [{ componentCode: "go", value: `去程从出发地到丽江${mode}` }] },
    { clauseItemId: 38739, selected: "T", clauseComponentDtos: [{ componentCode: "back", value: `返程从丽江到到达地${mode}` }] },
  ];
  if (variant === "trainRoundTrip") traffic.push({
    clauseItemId: 10071,
    selected: "T",
    clauseComponentDtos: [{ componentCode: "child", value: "儿童是否含火车票，以订单年龄为准" }],
  });
  return {
    clauseTypeDtos: [{
      clauseTypeId: 86,
      clauseTypeName: "交通",
      clauseItemDtos: traffic,
    }, {
      clauseTypeId: 316,
      clauseTypeName: "接送",
      clauseItemDtos: [{
        clauseItemId: 33006,
        selected: "F",
        clauseComponentDtos: [{ componentCode: "live-transfer", value: "目的地接送" }],
      }],
    }],
  };
}

function clauseApiMock(options: {
  lateRequiredOnce?: boolean;
  persistentLateRequired?: boolean;
  pendingOnEveryProbe?: boolean;
  preloaded?: boolean;
  omitFirstAutoResponse?: boolean;
  omitEveryAutoResponse?: boolean;
}) {
  let autoCalls = 0;
  const saves = new Map<number, number>();
  const saved = new Map<number, Array<Record<string, unknown>>>();
  if (options.preloaded) {
    saved.set(1, [
      { clauseItemId: 38725 }, { clauseItemId: 38739 }, { clauseItemId: 33006 },
    ]);
    saved.set(4, [{ clauseItemId: 1153 }]);
  }
  const page = {
    evaluate: async (_fn: unknown, arg: any) => {
      const endpoint = String(arg.endpoint);
      const body = arg.body as Record<string, any>;
      const ok = (extra: Record<string, unknown> = {}) => ({
        status: 200,
        payload: { ResponseStatus: { Ack: "Success", Errors: [] }, ...extra },
        durationMs: 1,
        ctx: {},
      });
      if (endpoint.endsWith("/20698/getProductClause")) {
        return ok({ formalDtos: formalIds().map((clauseItemId) => ({ clauseItemId })) });
      }
      if (endpoint.endsWith("/20698/autoSaveRequiredTextClause")) {
        autoCalls += 1;
        if (options.omitEveryAutoResponse) return ok();
        if (options.omitFirstAutoResponse && autoCalls === 1) return ok();
        const pending = options.pendingOnEveryProbe
          || (options.lateRequiredOnce && autoCalls === 3)
          || (options.persistentLateRequired && autoCalls >= 3);
        return ok({ manualSaveClauseTipDtos: pending ? [{ tabNum: 4, clauseItemIds: [1153] }] : [] });
      }
      if (endpoint.endsWith("/15638/listProductClauses")) {
        const tab = Number(body.tabEnum);
        return ok({ centralDataDto: central(tab) });
      }
      if (endpoint.endsWith("/20046/getClausePackage")) {
        const tab = Number(body.firstClassClauseTypeIds?.[0]);
        return ok(schemaForTab(tab));
      }
      if (endpoint.endsWith("/20046/saveClausePackage")) {
        const tab = Number(body.firstClassClauseTypeIds?.[0]);
        saved.set(tab, structuredClone(body.clausePackageItemDtos ?? []));
        saves.set(tab, (saves.get(tab) ?? 0) + 1);
        return ok({ clausePackageId: 9000 + tab });
      }
      if (endpoint.endsWith("/20698/createProductDraft") || endpoint.endsWith("/15638/saveProductClauses.json")) {
        return ok();
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  } as any;
  const central = (tab: number) => ({
    clausePackageId: 9000 + tab,
    additionalInfoDto: { firstClassTypeIds: [tab] },
    filterConditionDto: {
      productId: 77990001,
      pICategoryId: 1003,
      resourceConfigDto: {
        isIncludeSystemFlight: "T",
        hasOutWardTraffic: "T",
        hasReturnTraffic: "T",
      },
    },
  });
  const schemaForTab = (tab: number) => {
    const selected = new Set((saved.get(tab) ?? []).map((item) => Number(item.clauseItemId)));
    if (tab === 1) {
      const schema = childClauseSchema("flightRoundTrip");
      schema.clauseTypeDtos[1]!.clauseItemDtos[0]!.selected = selected.has(33006) ? "T" : "F";
      return schema;
    }
    if (tab === 4) return {
      clauseTypeDtos: [{
        clauseTypeId: 21,
        containers: [{ clauseItemDtos: [{
          clauseItemId: 1153,
          selected: selected.has(1153) ? "T" : "F",
          clauseComponentDtos: [{ componentCode: "tourlimit9", value: "1" }],
        }] }],
      }],
    };
    return { clauseTypeDtos: [] };
  };
  const formalIds = () => [...new Set([
    38725,
    38739,
    ...[...saved.values()].flat().map((item) => Number(item.clauseItemId)),
  ])];
  return {
    page,
    autoSaveCalls: () => autoCalls,
    savedIds: (tab: number) => (saved.get(tab) ?? []).map((item) => Number(item.clauseItemId)),
    saveCalls: (tab: number) => saves.get(tab) ?? 0,
  };
}
