/**
 * automation.main 收尾单元测试：
 *   - finalizeRunWithScreenshot：best-effort 截图。成功写 path；失败仅写
 *     warning、置 run.screenshot 为 undefined、不抛错。这条 helper 是
 *     G2 容错的关键 —— 旧实现是内联 await saveScreenshot，宽度=0 / page
 *     detach 时抛进 catch，被外层当 failed + blocked，造成「截图失败
 *     = 业务误标 failed」的核心 bug。把它隔离成纯函数让验收门 2 行得
 *     到直接可执行的回归断言，而不是字符串匹配。
 *
 * 验收门：
 *   G1 业务成功 + 截图成功：run.screenshot 写入路径、无 warning log。
 *   G2 业务成功 + 截图失败：screenshot 路径置 undefined、写一条 warning、
 *     不抛错。run.status / currentPhase / draft_saved 由调用方负责，本
 *     helper 只断言自己这一段不影响这些状态位 —— 由 review & 对比
 *     run.ts catch 分支的等价性来担保。
 *
 * catch 中的两个失败分支（AutomationCancelledError 不污染状态；其它
 * 错误落 failed + blocked）行为完全等于 diff 前的内联代码 —— 这部分
 * 改动面是 0 行（仅做了一次函数抽取），回归覆盖交由 review 与既有
 * e2e 抓，不在本单测里造 mock 一坨 VbkDatabase 把 catch 整段跑起来。
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationRun } from "../../src/shared/contracts.js";
import { finalizeRunWithScreenshot } from "../../src/main/automation/automation.main/automation.main.run.finalize.js";

// ───────────────────────── helpers ─────────────────────────

function makeRun(): AutomationRun {
  return {
    id: "run-finalize-1",
    status: "running",
    currentPhase: "preflight",
    phases: [{ phase: "preflight", status: "completed" }],
    logs: [],
  };
}

interface LogCall {
  message: string;
  level: "info" | "warning" | "error" | undefined;
}

function makeLogSink(): { log: (message: string, level?: "info" | "warning" | "error") => void; calls: LogCall[] } {
  const calls: LogCall[] = [];
  return { calls, log: (message, level) => { calls.push({ message, level }); } };
}

// ───────────────────────── G1: 截图成功 ─────────────────────────

test("G1 截图成功：run.screenshot 写绝对路径，不写 warning，不抛错", async () => {
  const run = makeRun();
  const sink = makeLogSink();
  let callArgs: { prefix: string; productId: string } | null = null;
  await finalizeRunWithScreenshot(
    run,
    async (_page, prefix, productId) => {
      callArgs = { prefix, productId };
      return `/tmp/${prefix}-${productId}-1700000000000.png`;
    },
    "P123",
    { dummy: true },
    sink.log,
  );
  assert.equal(run.screenshot, "/tmp/desktop-draft-P123-1700000000000.png");
  assert.deepEqual(sink.calls, [], "成功路径不应写 warning");
  assert.deepEqual(callArgs, { prefix: "desktop-draft", productId: "P123" });
});

// ───────────────────────── G2: 截图失败（核心 bug 回归） ─────────────────────────

test("G2 截图抛 Error：写 warning 含原始 message、screenshot 置 undefined、不抛错", async () => {
  const run = makeRun();
  const sink = makeLogSink();
  await assert.doesNotReject(
    () => finalizeRunWithScreenshot(
      run,
      async () => { throw new Error("Cannot take screenshot with 0 width"); },
      "P123",
      { dummy: true },
      sink.log,
    ),
    "截图失败必须被吞掉，绝不抛错",
  );
  assert.equal(run.screenshot, undefined, "失败时 run.screenshot 必须显式置为 undefined");
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0].level, "warning");
  assert.match(sink.calls[0].message, /收尾截图失败/);
  assert.match(sink.calls[0].message, /Cannot take screenshot with 0 width/);
  assert.match(sink.calls[0].message, /业务已完成/);
  assert.equal(run.status, "running", "本 helper 不应改变 run.status —— 由调用方负责 succeeded");
  assert.equal(run.currentPhase, "preflight", "本 helper 不应清 currentPhase —— 由调用方负责");
});

test("G2 截图抛非 Error：用 String(error) 入 warning", async () => {
  const run = makeRun();
  const sink = makeLogSink();
  // eslint-disable-next-line no-throw-literal
  await finalizeRunWithScreenshot(run, async () => { throw "string-throw"; }, "P123", {}, sink.log);
  assert.equal(run.screenshot, undefined);
  assert.equal(sink.calls[0].level, "warning");
  assert.match(sink.calls[0].message, /string-throw/);
});

test("G2 截图失败必须清掉 stale 路径，避免被误用为有效路径", async () => {
  // 边界：run.screenshot 在调用方进入本 helper 之前就非空（极少见，但语义要明确）。
  const run: AutomationRun = { ...makeRun(), screenshot: "/stale/from/previous/run.png" };
  await finalizeRunWithScreenshot(
    run,
    async () => { throw new Error("playwright: page closed"); },
    "P123", {}, () => undefined,
  );
  assert.equal(run.screenshot, undefined, "stale path 必须被清掉");
});
