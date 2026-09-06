import test from "node:test";
import assert from "node:assert/strict";
import { getCtripSightAvailability, getCtripSightAvailabilities } from "../../src/main/infrastructure/ctrip-sight-availability.js";

test("携程景点详情以 openInfo.openStatus 判断暂停营业", async () => {
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    calls.push({ endpoint: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      result: 0,
      openInfo: { openStatus: "暂停营业", latelyOpenTime: "2027年5月1日恢复营业" },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    assert.deepEqual(await getCtripSightAvailability({ evaluate: async () => undefined as never }, 82723), {
      status: "suspended", openStatus: "暂停营业", latelyOpenTime: "2027年5月1日恢复营业",
    });
    assert.equal(calls[0]?.endpoint, "https://m.ctrip.com/restapi/soa2/18109/json/getSightOnlinePage");
    assert.deepEqual(calls[0]?.body, { head: { syscode: "999" }, poiId: 82723 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 430 时按提示挂起等待后再继续，而不是立刻连续失败", async () => {
  const calls: number[] = [];
  const originalFetch = globalThis.fetch;
  let phase = 0;
  globalThis.fetch = (async (_input, init) => {
    const poiId = (JSON.parse(String(init?.body)) as { poiId: number }).poiId;
    calls.push(poiId);
    phase += 1;
    if (phase === 1) {
      return new Response("请 1 秒后重试", {
        status: 430,
        headers: { "retry-after": "1" },
      });
    }
    return new Response(JSON.stringify({ result: 0, openInfo: { openStatus: "" } }), { status: 200 });
  }) as typeof fetch;

  try {
    const started = Date.now();
    const result = await getCtripSightAvailability({ evaluate: async () => undefined as never }, 91001);
    assert.deepEqual(result, { status: "available", openStatus: "", latelyOpenTime: null });
    assert.ok(Date.now() - started >= 900, "应至少等待约 1 秒冷却");
    assert.deepEqual(calls, [91001, 91001]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("多个 POI 以单 ID 请求受控聚合，重复 ID 只查询一次", async () => {
  const calls: number[] = [];
  let active = 0;
  let maxActive = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const poiId = (JSON.parse(String(init?.body)) as { poiId: number }).poiId;
    calls.push(poiId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(JSON.stringify({ result: 0, openInfo: { openStatus: poiId === 90002 ? "暂停营业" : "" } }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await getCtripSightAvailabilities({ evaluate: async () => undefined as never }, [90001, 90002, 90001]);
    assert.deepEqual([...result.entries()], [
      [90001, { status: "available", openStatus: "", latelyOpenTime: null }],
      [90002, { status: "suspended", openStatus: "暂停营业", latelyOpenTime: null }],
    ]);
    assert.deepEqual(calls.sort(), [90001, 90002]);
    assert.equal(maxActive, 1, "景点营业状态请求必须串行，避免突发并发");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
