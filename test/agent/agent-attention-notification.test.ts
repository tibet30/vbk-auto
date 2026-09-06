import test from "node:test";
import assert from "node:assert/strict";
import { agentAttentionNotification } from "../../src/main/infrastructure/agent-attention-notification.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

const run = (status: NonNullable<AgentSnapshot["run"]>["status"]): NonNullable<AgentSnapshot["run"]> => ({
  id: "run-1", status, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:01:00.000Z",
});

test("等待用户补充信息时生成通知", () => {
  const result = agentAttentionNotification({
    localProductId: "product-1", run: run("waiting_input"), events: [],
    pendingInput: { id: "request-1", createdAt: "2026-09-06T00:01:00.000Z", questions: [] },
  }, "西藏之旅");
  assert.deepEqual(result, {
    key: "run-1:input:request-1",
    title: "西藏之旅需要你的补充",
    body: "AI 正在等待你补充信息，打开应用继续对话。",
  });
});

test("等待审批和失败时生成稳定的去重键", () => {
  const approval = agentAttentionNotification({
    localProductId: "product-1", run: run("waiting_approval"), events: [],
    pendingApproval: {
      id: "approval-1", productVersion: "v1", accountKey: "account", scope: [],
      summary: "确认", status: "pending", createdAt: "2026-09-06T00:01:00.000Z",
    },
  });
  const failedRun = { ...run("failed"), error: "请检查登录状态" };
  const failed = agentAttentionNotification({ localProductId: "product-1", run: failedRun, events: [] });
  assert.equal(approval?.key, "run-1:approval:approval-1");
  assert.equal(failed?.key, "run-1:failed:2026-09-06T00:01:00.000Z:请检查登录状态");
  assert.equal(failed?.body, "请检查登录状态");
});

test("运行中、暂停和已完成状态不发需要处理通知", () => {
  for (const status of ["queued", "running", "paused", "completed", "abandoned"] as const) {
    assert.equal(agentAttentionNotification({ localProductId: "product-1", run: run(status), events: [] }), null);
  }
  assert.equal(agentAttentionNotification({ localProductId: "product-1", run: run("waiting_input"), events: [] }), null);
});
