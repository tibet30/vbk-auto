import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunStatus, AgentSnapshot, ProductWorkflowTask } from "../../src/shared/contracts.js";
import { recoverQueuedAgentWorkflowTasks } from "../../src/main/agent/integration-workflow.js";

function task(overrides: Partial<ProductWorkflowTask> = {}): ProductWorkflowTask {
  return {
    id: "task-1",
    localProductId: "product-1",
    productName: "测试产品",
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "等待执行",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(status?: AgentRunStatus): AgentSnapshot {
  return {
    localProductId: "product-1",
    events: [],
    run: status
      ? {
          id: "run-1",
          status,
          intentVersion: "1",
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:00:01.000Z",
        }
      : undefined,
  };
}

test("启动恢复：无 Agent run 的 queued 任务改为 needs_attention", async () => {
  const rows = [task()];
  const emitted: ProductWorkflowTask[] = [];
  const result = await recoverQueuedAgentWorkflowTasks({
    listWorkflowTasks: () => rows,
    updateWorkflowTask: (id, patch) => {
      const next = { ...rows[0]!, ...patch, id, updatedAt: "2026-09-06T00:01:00.000Z" };
      rows[0] = next;
      return next;
    },
    getAgentSnapshot: async () => snapshot(),
    resumeAgent: async () => {
      throw new Error("orphan 不应 resume");
    },
    emitWorkflowTask: (item) => { emitted.push(item); },
  });
  assert.equal(result.attention, 1);
  assert.equal(result.resumed, 0);
  assert.equal(emitted[0]?.status, "needs_attention");
  assert.match(emitted[0]?.message ?? "", /方案协作/);
});

test("启动恢复：queued/running Agent 会 resume", async () => {
  const resumed: string[] = [];
  for (const status of ["queued", "running"] as const) {
    resumed.length = 0;
    const result = await recoverQueuedAgentWorkflowTasks({
      listWorkflowTasks: () => [task({ id: `task-${status}` })],
      updateWorkflowTask: () => {
        throw new Error("active agent 不应改成 attention");
      },
      getAgentSnapshot: async () => snapshot(status),
      resumeAgent: async (localProductId) => {
        resumed.push(localProductId);
        return snapshot("running");
      },
      emitWorkflowTask: () => {
        throw new Error("resume 路径不直接 emit workflow");
      },
    });
    assert.equal(result.resumed, 1, status);
    assert.deepEqual(resumed, ["product-1"]);
  }
});

test("启动恢复：paused Agent 不自动 resume，留给任务中心", async () => {
  let resumeCalls = 0;
  const result = await recoverQueuedAgentWorkflowTasks({
    listWorkflowTasks: () => [task()],
    updateWorkflowTask: () => {
      throw new Error("paused 不应改写为 attention（get 已同步）");
    },
    getAgentSnapshot: async () => snapshot("paused"),
    resumeAgent: async () => {
      resumeCalls += 1;
      return snapshot("running");
    },
    emitWorkflowTask: () => undefined,
  });
  assert.equal(result.resumed, 0);
  assert.equal(result.attention, 0);
  assert.equal(resumeCalls, 0);
});
