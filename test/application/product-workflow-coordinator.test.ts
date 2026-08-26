import assert from "node:assert/strict";
import test from "node:test";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";

test("同一产品的 AI 与 planning 互斥，且冲突不会执行第二个任务", async () => {
  const coordinator = new ProductWorkflowCoordinator();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const planning = coordinator.runExclusive("p-1", "planning", async () => {
    await gate;
    return "done";
  });

  let aiRan = false;
  await assert.rejects(
    coordinator.runExclusive("p-1", "ai", async () => { aiRan = true; }),
    /产品规划正在进行中，不能同时启动AI 对话/,
  );
  assert.equal(aiRan, false);
  assert.throws(
    () => coordinator.assertIdle("p-1", "manual"),
    /产品规划正在进行中，不能同时启动运营手工编辑/,
  );
  release();
  assert.equal(await planning, "done");
});

test("不同产品可并行，同一产品在成功或异常后都会释放", async () => {
  const coordinator = new ProductWorkflowCoordinator();
  const values = await Promise.all([
    coordinator.runExclusive("p-1", "ai", async () => 1),
    coordinator.runExclusive("p-2", "planning", async () => 2),
  ]);
  assert.deepEqual(values, [1, 2]);

  await assert.rejects(
    coordinator.runExclusive("p-1", "automation", async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(coordinator.activeWorkflow("p-1"), undefined);
  assert.equal(await coordinator.runExclusive("p-1", "ai", async () => 3), 3);
});

test("不同产品的共享 VBK 页面操作按 FIFO 串行，但不影响产品级并行", async () => {
  const coordinator = new ProductWorkflowCoordinator();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

  const first = coordinator.runVbkPageExclusive(async () => {
    events.push("first:start");
    markFirstStarted();
    await firstGate;
    events.push("first:end");
  });
  const second = coordinator.runVbkPageExclusive(async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await firstStarted;
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("共享 VBK 页面任务失败后仍释放队列", async () => {
  const coordinator = new ProductWorkflowCoordinator();
  await assert.rejects(
    coordinator.runVbkPageExclusive(async () => { throw new Error("page failed"); }),
    /page failed/,
  );
  assert.equal(await coordinator.runVbkPageExclusive(async () => "next"), "next");
});
