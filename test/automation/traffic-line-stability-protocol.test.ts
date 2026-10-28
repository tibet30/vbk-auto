import test from "node:test";
import assert from "node:assert/strict";

import { ensureTrafficLineItinerary, verifyTrafficNodes } from "../../src/main/automation/ctrip/traffic-line/itinerary.ts";
import { waitForSegmentSubmit } from "../../src/main/automation/ctrip/traffic-line/segments.ts";
import { invalidateTrafficLineFinalReadback } from "../../src/main/automation/ctrip/traffic-line/main.ts";
import { invalidateTrafficLineWorkflowVerification } from "../../src/main/automation/ctrip/traffic-line/run-phase.ts";
import { waitForStableReadbackGroup } from "../../src/main/automation/ctrip/traffic-line/stability.ts";

test("整组稳定门捕获后续漂移，定向修复后重新连续核验", async () => {
  const states = ["stable-a", "missing", "stable-b", "stable-b"];
  const waits: number[] = [];
  let repairs = 0;
  let finalCheckpoints = 0;
  const result = await waitForStableReadbackGroup([{ id: "flight" }], {
    key: (item) => item.id,
    verify: async () => {
      const state = states.shift();
      if (state === "missing") throw new Error("known-missing-nodes");
      return { tourInfoId: state };
    },
    signature: (_item, readback) => readback.tourInfoId ?? "",
    canRepair: (error) => error instanceof Error && error.message === "known-missing-nodes",
    repair: async () => { repairs += 1; },
  }, {
    intervalMs: 30_000,
    requiredConsecutive: 2,
    maxSamples: 4,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  finalCheckpoints += 1;
  assert.deepEqual(result, [{ tourInfoId: "stable-b" }]);
  assert.equal(repairs, 1);
  assert.equal(finalCheckpoints, 1);
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 30_000]);
});

test("稳定门不把会话失败当成可修复业务缺失，也不接受二次漂移", async () => {
  let repairs = 0;
  await assert.rejects(() => waitForStableReadbackGroup([{ id: "train" }], {
    key: (item) => item.id,
    verify: async () => { throw new Error("当前用户未登录"); },
    signature: () => "unused",
    canRepair: () => false,
    repair: async () => { repairs += 1; },
  }, { intervalMs: 0, sleep: async () => {} }), /当前用户未登录/);
  assert.equal(repairs, 0);

  const states = ["missing", "stable", "missing"];
  await assert.rejects(() => waitForStableReadbackGroup([{ id: "train" }], {
    key: (item) => item.id,
    verify: async () => {
      const state = states.shift();
      if (state === "missing") throw new Error("known-missing-nodes");
      return state;
    },
    signature: (_item, readback) => readback ?? "",
    canRepair: (error) => error instanceof Error && error.message === "known-missing-nodes",
    repair: async () => { repairs += 1; },
  }, { intervalMs: 0, maxSamples: 3, sleep: async () => {} }), /known-missing-nodes/);
  assert.equal(repairs, 1);
});

test("默认稳定门覆盖 90 秒窗口，前两次成功后的漂移不能提前完成", async () => {
  const states = ["old", "old", "missing", "new", "new", "new"];
  let repairs = 0;
  const waits: number[] = [];
  const result = await waitForStableReadbackGroup([{ id: "flight" }], {
    key: (item) => item.id,
    verify: async () => {
      const state = states.shift();
      if (state === "missing") throw new Error("known-missing-nodes");
      return state;
    },
    signature: (_item, readback) => readback ?? "",
    canRepair: (error) => error instanceof Error && error.message === "known-missing-nodes",
    repair: async () => { repairs += 1; },
  }, {
    maxSamples: 6,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, ["new"]);
  assert.equal(repairs, 1);
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
});

test("重验开始原子撤销历史 finalReadback 与 verifiedAt", () => {
  const child = invalidateTrafficLineFinalReadback({
    variant: "flightRoundTrip",
    lineDescription: "飞机往返",
    childProductId: "child-1",
    completedStages: ["planned", "childCreated", "activated", "finalReadback"],
    verified: true,
  });
  assert.deepEqual(child.completedStages, ["planned", "childCreated", "activated"]);
  assert.equal(child.verified, false);

  const workflow = invalidateTrafficLineWorkflowVerification({
    children: [child],
    verifiedAt: "2026-09-03T00:00:00.000Z",
    failureReason: "旧错误",
  });
  assert.equal(workflow.verifiedAt, undefined);
  assert.equal(workflow.failureReason, undefined);
});
test("行程交通回读诊断会列出首末边界日节点与卡片状态", () => {
  try {
    verifyTrafficNodes({
      tourDailyDescriptions: [
        { tourDailyInfos: [
          { activeType: { key: 3, name: "景点" } },
          { activeType: { key: 2, name: "航班" }, tourDailyFlights: [] },
        ] },
        { tourDailyInfos: [{ activeType: { key: 3, name: "景点" } }] },
      ],
    }, "flightRoundTrip");
    assert.fail("应抛出带诊断的错误");
  } catch (error) {
    assert.match(
      (error as Error).message,
      /缺少首日或末日目标交通节点（首日\[景点、航班\(缺车次\/航班卡片\)\]；末日\[景点\]）/,
    );
  }
});

test("校验响应丢失交通卡片时立即失败并带边界诊断", async () => {
  const requests: Array<{ path: string; body: any }> = [];
  let check3Count = 0;
  const trainNode = (title: string) => ({
    activeType: { key: 14, name: "火车" },
    title,
    tourDailyPackageTrains: [{ trainNo: "C895" }],
    tourDailyTrains: [],
  });
  const parentStateJson = JSON.stringify({
    dailyContext: { tourDailyDescriptions: [
      { tourDailyInfos: [trainNode("去程")] },
      { tourDailyInfos: [trainNode("回程")] },
    ] },
  });
  const parentHtml = "<script>window.__INITIAL_STATE__ = " + parentStateJson + ";</script>";
  const detailWithoutTraffic = () => ({
    tourInfo: {
      tourInfoId: 9100,
      tourDailyDescriptions: [
        { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
        { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
      ],
    },
  });
  const stripTrafficCards = (tourDailyText: string) => {
    const payload = JSON.parse(tourDailyText) as any;
    for (const day of payload.tourDailyDescriptions ?? []) {
      for (const node of day.tourDailyInfos ?? []) {
        delete node.tourDailyPackageTrains;
        node.tourDailyTrains = [];
      }
    }
    return JSON.stringify(payload);
  };

  const page = {
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A) {
      const previousDocument = (globalThis as { document?: unknown }).document;
      const previousFetch = globalThis.fetch;
      (globalThis as { document?: { cookie: string } }).document = { cookie: "GUID=CID-VALUE" };
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname.split("/").pop() ?? "";
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ path, body });
        const ok = (payload: unknown) => new Response(JSON.stringify({ ResponseStatus: { Ack: "Success", Errors: [] }, ...payload }), { status: 200 });
        if (path === "getProductTourInfoList") {
          return ok({ tourInfos: [{ tourInfoId: 9100, main: true, sort: 0, days: 2 }] });
        }
        if (path === "getTourDailyDetail.json") {
          return ok(detailWithoutTraffic());
        }
        if (path === "checkTourDaily") {
          if (body.saveType === 8) return ok({ tourDaily: body.tourDaily });
          check3Count += 1;
          return ok({ tourDaily: stripTrafficCards(body.tourDaily) });
        }
        if (path === "calculateTourInfoScore") {
          return ok({ tourInfo: { aggregateScore: 100, tourInfoScores: [] } });
        }
        throw new Error("unexpected path " + path);
      }) as typeof fetch;
      try {
        return await fn(arg);
      } finally {
        globalThis.fetch = previousFetch;
        if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else (globalThis as { document?: unknown }).document = previousDocument;
      }
    },
    vbkSessionGetText: async () => ({ status: 200, text: parentHtml }),
  };

  await assert.rejects(
    () => ensureTrafficLineItinerary(page as never, "78350600", "trainRoundTrip"),
    /缺少首日或末日目标交通节点/,
  );
  assert.equal(check3Count, 1);
  assert.equal(requests.some((request) => request.path === "saveTourDailyDetail.json"), false);
});

test("持续pending到恢复阈值停止只读等待，成功结果不触发恢复", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let result = "U", reads = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => { reads++; return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success", Errors: [] }, result }), { status: 200 }); }) as typeof fetch;
  try {
    const page = { evaluate: async (fn: any, arg: any) => fn(arg) } as any;
    await assert.rejects(() => waitForSegmentSubmit(page, "child", { shouldStopWaiting: () => true, sleep: async () => {} }), /异步核验.*恢复阈值/);
    assert.equal(reads, 1);
    result = "T";
    assert.deepEqual(await waitForSegmentSubmit(page, "child", { shouldStopWaiting: () => true }), []);
    assert.equal(reads, 2);
  } finally { globalThis.fetch = originalFetch; (globalThis as { document?: unknown }).document = originalDocument; }
});
