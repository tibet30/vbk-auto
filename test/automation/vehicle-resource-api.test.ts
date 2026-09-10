import assert from "node:assert/strict";
import test from "node:test";
import { ensureVehicleResourceBinding, ensureVehicleResourceGroupDraft } from "../../src/main/automation/ctrip/vehicle-resource-api.js";

const groupId = 2206177;

function group(segmentId: string) {
  return { segmentId, resourceGroupId: groupId, resourceGroup: { resourceGroupId: groupId, vendorId: 4455 } };
}

test("用车组写入后以最新资源段清理重复绑定", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  let segments: any[] = [
    { segmentId: "terminal", segmentBase: { segmentNumber: 4, destinationCity: { cityId: 0, cityName: "多到达" } }, segmentResourceGroups: [group("terminal")] },
    { segmentId: "lodging", segmentBase: { segmentNumber: 3 }, segmentResourceGroups: [group("lodging")] },
    { segmentId: "full", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [] },
    { segmentId: "boundary", segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" } }, segmentResourceGroups: [group("boundary")] },
  ];
  const savedSegments: any[] = [];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("saveSegment")) {
      const saved = structuredClone(body.segment);
      savedSegments.push(saved);
      segments = segments.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success" },
      draftProductSegments: { segments: structuredClone(segments) },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureVehicleResourceGroupDraft(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "78090477",
      groupId,
      "测试用车资源组",
      { verifyDraft: true },
    );
    assert.equal(result.changed, true);
    assert.deepEqual(
      segments.filter((segment) => segment.segmentResourceGroups.some((item: any) => item.resourceGroupId === groupId))
        .map((segment) => segment.segmentId),
      ["full"],
    );
    assert.deepEqual(savedSegments.map((segment) => [segment.segmentId, segment.segmentResourceGroups]), [
      ["full", [{ resourceGroupId: groupId, sort: 0, resourceGroup: { vendorId: 4455 } }]],
      ["boundary", []],
      ["lodging", []],
      ["terminal", []],
    ]);
  } finally {
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});

test("资源段提交清空交通子产品草稿后，重新绑定并以正式段回读确认", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  let submitted = false;
  let segments: any[] = [
    { segmentId: "boundary", segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" } }, segmentResourceGroups: [] },
    { segmentId: "full", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [] },
    { segmentId: "terminal", segmentBase: { segmentNumber: 3, destinationCity: { cityId: 0, cityName: "多到达" } }, segmentResourceGroups: [] },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("saveSegment")) {
      const saved = structuredClone(body.segment);
      segments = segments.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    if (endpoint.endsWith("submitSegments")) submitted = true;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success" },
      ...(submitted
        ? { productSegments: { segments: structuredClone(segments) } }
        : { draftProductSegments: { segments: structuredClone(segments) } }),
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureVehicleResourceBinding(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "78193841",
      groupId,
      "测试用车资源组",
    );
    assert.equal(result.audited, true);
    assert.equal(submitted, true);
    assert.deepEqual(
      segments.filter((segment) => segment.segmentResourceGroups.some((item: any) => item.resourceGroupId === groupId))
        .map((segment) => segment.segmentId),
      ["full"],
    );
  } finally {
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});

test("提交后轮询正式资源段，吸收平台异步结算", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  let submitted = false;
  let formalReadbacks = 0;
  let segments: any[] = [
    { segmentId: "boundary", segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" } }, segmentResourceGroups: [] },
    { segmentId: "full", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [] },
    { segmentId: "terminal", segmentBase: { segmentNumber: 3, destinationCity: { cityId: 0, cityName: "多到达" } }, segmentResourceGroups: [] },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("saveSegment")) {
      const saved = structuredClone(body.segment);
      segments = segments.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    if (endpoint.endsWith("submitSegments")) submitted = true;
    const formal = submitted && endpoint.endsWith("getSegments");
    if (formal) formalReadbacks += 1;
    const visibleSegments = formal && formalReadbacks < 3
      ? segments.map((segment) => ({ ...segment, segmentResourceGroups: [] }))
      : segments;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success" },
      ...(formal
        ? { productSegments: { segments: structuredClone(visibleSegments) } }
        : { draftProductSegments: { segments: structuredClone(segments) } }),
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureVehicleResourceBinding(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "78193841",
      groupId,
      "测试用车资源组",
      { formalReadbackAttempts: 3, formalReadbackIntervalMs: 0 },
    );
    assert.equal(result.audited, true);
    assert.equal(formalReadbacks, 3);
  } finally {
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});

test("默认正式段轮询窗口足够吸收较慢的用车绑定结算", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  let submitted = false;
  let formalReadbacks = 0;
  let segments: any[] = [
    { segmentId: "full", segmentBase: { segmentNumber: 1 }, segmentResourceGroups: [] },
    { segmentId: "terminal", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [] },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("saveSegment")) {
      const saved = structuredClone(body.segment);
      segments = segments.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    if (endpoint.endsWith("submitSegments")) submitted = true;
    const formal = submitted && endpoint.endsWith("getSegments");
    if (formal) formalReadbacks += 1;
    const visibleSegments = formal && formalReadbacks < 10
      ? segments.map((segment) => ({ ...segment, segmentResourceGroups: [] }))
      : segments;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success" },
      ...(formal
        ? { productSegments: { segments: structuredClone(visibleSegments) } }
        : { draftProductSegments: { segments: structuredClone(segments) } }),
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureVehicleResourceBinding(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "78193841",
      groupId,
      "测试用车资源组",
      { formalReadbackIntervalMs: 0 },
    );
    assert.equal(result.audited, true);
    assert.equal(formalReadbacks, 10);
  } finally {
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});

test("提交后若仅草稿绑定、正式段未绑定，用车回读必须失败", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const draftSegments: any[] = [
    { segmentId: "boundary", segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" } }, segmentResourceGroups: [] },
    { segmentId: "full", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [group("full")] },
    { segmentId: "terminal", segmentBase: { segmentNumber: 3, destinationCity: { cityId: 0, cityName: "多到达" } }, segmentResourceGroups: [] },
  ];
  const formalSegments: any[] = [
    { segmentId: "boundary", segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" } }, segmentResourceGroups: [] },
    { segmentId: "full", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [] },
    { segmentId: "terminal", segmentBase: { segmentNumber: 3, destinationCity: { cityId: 0, cityName: "多到达" } }, segmentResourceGroups: [] },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ResponseStatus: { Ack: "Success" },
    draftProductSegments: { segments: structuredClone(draftSegments) },
    productSegments: { segments: structuredClone(formalSegments) },
  }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      () => ensureVehicleResourceBinding(
        { evaluate: async (fn: any, arg: any) => fn(arg) },
        "78193841",
        groupId,
        "测试用车资源组",
        { submitDraft: true, formalReadbackAttempts: 2, formalReadbackIntervalMs: 0 },
      ),
      /应仅绑定全程首段/,
    );
  } finally {
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});

test("交通子产品草稿已有用车组时仍提交一次，取得正式资源段回读", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  let submitted = false;
  const segments: any[] = [
    { segmentId: "boundary", segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" } }, segmentResourceGroups: [] },
    { segmentId: "full", segmentBase: { segmentNumber: 2 }, segmentResourceGroups: [group("full")] },
    { segmentId: "terminal", segmentBase: { segmentNumber: 3, destinationCity: { cityId: 0, cityName: "多到达" } }, segmentResourceGroups: [] },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("submitSegments")) submitted = true;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success" },
      ...(submitted
        ? { productSegments: { segments: structuredClone(segments) } }
        : { draftProductSegments: { segments: structuredClone(segments) } }),
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureVehicleResourceBinding(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "78193841",
      groupId,
      "测试用车资源组",
      { submitDraft: true },
    );
    assert.equal(result.audited, true);
    assert.equal(submitted, true);
  } finally {
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});
