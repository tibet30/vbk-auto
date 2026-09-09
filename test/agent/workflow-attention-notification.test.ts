import test from "node:test";
import assert from "node:assert/strict";
import { workflowAttentionNotification } from "../../src/main/infrastructure/workflow-attention-notification.js";
import type { ProductWorkflowTask } from "../../src/shared/contracts.js";

function task(status: ProductWorkflowTask["status"]): ProductWorkflowTask {
  return {
    id: "task-1",
    localProductId: "product-1",
    productName: "林芝之旅",
    status,
    stage: "automation",
    progress: 70,
    message: "请检查 VBK 登录状态",
    error: status === "failed" ? "登录状态已失效" : undefined,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:01:00.000Z",
  };
}

test("后台任务等待处理和执行失败时生成通知", () => {
  const attention = workflowAttentionNotification(task("needs_attention"));
  const failed = workflowAttentionNotification(task("failed"));

  assert.equal(attention?.title, "林芝之旅需要你的处理");
  assert.equal(attention?.body, "请检查 VBK 登录状态");
  assert.equal(failed?.title, "林芝之旅执行失败");
  assert.equal(failed?.body, "登录状态已失效");
});

test("普通后台任务状态不发送系统通知", () => {
  for (const status of ["queued", "running", "succeeded", "cancelled", "abandoned"] as const) {
    assert.equal(workflowAttentionNotification(task(status)), null);
  }
});
