import test from "node:test";
import assert from "node:assert/strict";
import { scheduleProviderIdRefresh } from "../../src/main/infrastructure/provider-id-source.js";

// ───────────────────────── helpers ─────────────────────────

interface DetectorCall {
  attempt: number;
}

function makeDetector(behaviour: Array<number | "throw">) {
  const calls: DetectorCall[] = [];
  const detector = async () => {
    calls.push({ attempt: calls.length + 1 });
    const next = behaviour.shift();
    if (next === undefined) throw new Error("detector queue exhausted");
    if (next === "throw") throw new Error("detector failed");
    return next;
  };
  return { detector, calls };
}

function makePage() {
  return { url: () => "about:blank" } as never;
}

// ───────────────────────── 测试 ─────────────────────────

test("成功路径：第一次探测就拿到 id，persist(123)", async () => {
  const { detector, calls } = makeDetector([123]);
  const persisted: Array<number | null> = [];
  await scheduleProviderIdRefresh("vbk_x", detector, (id) => persisted.push(id), { page: makePage() });
  assert.equal(calls.length, 1);
  assert.deepEqual(persisted, [123]);
});

test("重试路径：第一次失败、第二次成功 → persist(456)", async () => {
  const { detector, calls } = makeDetector(["throw", 456]);
  const persisted: Array<number | null> = [];
  await scheduleProviderIdRefresh("vbk_y", detector, (id) => persisted.push(id), { page: makePage() });
  assert.equal(calls.length, 2);
  assert.deepEqual(persisted, [456]);
});

test("两次都失败 → persist(null)", async () => {
  const { detector, calls } = makeDetector(["throw", "throw"]);
  const persisted: Array<number | null> = [];
  await scheduleProviderIdRefresh("vbk_z", detector, (id) => persisted.push(id), { page: makePage() });
  assert.equal(calls.length, 2);
  assert.deepEqual(persisted, [null]);
});

test("第一次成功时不触发第二次探测", async () => {
  // 只给 detector 一个值；如果第二次被调用会因队列空而抛错，被 schedule 内部 catch。
  const { detector, calls } = makeDetector([789]);
  const persisted: Array<number | null> = [];
  await scheduleProviderIdRefresh("vbk_a", detector, (id) => persisted.push(id), { page: makePage() });
  assert.equal(calls.length, 1);
  assert.deepEqual(persisted, [789]);
});

test("第一次返回 null（合法但无值）会被当作成功，不再重试", async () => {
  const { detector, calls } = makeDetector([null]);
  const persisted: Array<number | null> = [];
  await scheduleProviderIdRefresh("vbk_b", detector, (id) => persisted.push(id), { page: makePage() });
  assert.equal(calls.length, 1);
  assert.deepEqual(persisted, [null]);
});

test("没有 page 时直接 no-op：不调 detector，也不 persist", async () => {
  const { detector, calls } = makeDetector([123]);
  const persisted: Array<number | null> = [];
  // 没有 page → 立即返回
  await scheduleProviderIdRefresh("vbk_c", detector, (id) => persisted.push(id));
  assert.equal(calls.length, 0);
  assert.deepEqual(persisted, []);
});

test("schedule 不抛出：即使 detector 报错，主流程只走 persist(null)", async () => {
  const failingDetector = async () => { throw new Error("detector blow up"); };
  const persisted: Array<number | null> = [];
  // schedule 内部 try/catch，所以这里 await 不应 reject
  await assert.doesNotReject(async () => {
    await scheduleProviderIdRefresh("vbk_d", failingDetector, (id) => persisted.push(id), { page: makePage() });
  });
  assert.deepEqual(persisted, [null]);
});