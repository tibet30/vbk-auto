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
