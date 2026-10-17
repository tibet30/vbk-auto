import test from "node:test";
import assert from "node:assert/strict";
import { buildProductDiagnostics } from "../../src/main/application/product-diagnostic-builder.js";
import type { AgentSnapshot, ProductDetail, ProductWorkflowTask } from "../../src/shared/contracts.js";

const at = "2026-10-15T10:00:00+08:00";
const environment = { appVersion: "test", platform: "darwin", arch: "arm64" };
const product = (): ProductDetail => ({ id: "p1", name: "成都2天1晚自由行", status: "planning", updatedAt: at,
  product: { privateContent: "DO_NOT_UPLOAD" }, messages: [], researchTasks: [] });
const snapshot = (status: NonNullable<AgentSnapshot["run"]>["status"], events: AgentSnapshot["events"] = []): AgentSnapshot => ({
  localProductId: "p1", run: { id: "r1", status, createdAt: at, updatedAt: at }, events,
});
const task = (status: ProductWorkflowTask["status"], error?: string): ProductWorkflowTask => ({ id: "t1", localProductId: "p1",
  productName: "成都2天1晚自由行", status, stage: "planning", progress: 50, message: "处理中", ...(error ? { error } : {}),
  createdAt: at, updatedAt: at });

test("正常等待、完成、用户主动暂停和已恢复的工具错误均不上报", () => {
  for (const status of ["waiting_input", "waiting_approval", "completed", "abandoned"] as const) {
    assert.deepEqual(buildProductDiagnostics(product(), environment, snapshot(status)), []);
  }
  const manual = snapshot("paused", [{ id: "pause", runId: "r1", type: "status", content: "运行已暂停", createdAt: at,
    data: { status: "paused", reportIssue: false, operatorRequested: true } }]);
  assert.deepEqual(buildProductDiagnostics(product(), environment, manual), []);
  const recovered = snapshot("running", [{ id: "failed-tool", runId: "r1", type: "tool_result", content: "失败", createdAt: at,
    data: { error: "瞬时错误" } }]);
  assert.deepEqual(buildProductDiagnostics(product(), environment, recovered), []);
});

test("Agent 失败、系统暂停、连续阻塞和写入不确定生成最小异常", () => {
  const failed = snapshot("failed"); failed.run!.error = "规划失败 token=secret";
  const failedIssue = buildProductDiagnostics(product(), environment, failed)[0]!.issue;
  assert.equal(failedIssue.state, "failed");
  assert.doesNotMatch(failedIssue.reason, /secret/);

  const paused = snapshot("paused", [{ id: "pause", runId: "r1", type: "status", content: "住宿门禁仍未通过", createdAt: at,
    data: { status: "paused" } }]);
  assert.equal(buildProductDiagnostics(product(), environment, paused)[0]!.issue.state, "paused");

  const blocked = snapshot("paused", [{ id: "block", runId: "r1", type: "status", content: "反复无进展", createdAt: at,
    data: { status: "paused", noProgressPaused: true, noProgressBlockers: ["completion_blocked"],
      noProgressLatestReason: "完成检查未通过" } }]);
  const blockedIssue = buildProductDiagnostics(product(), environment, blocked)[0]!.issue;
  assert.equal(blockedIssue.state, "blocked");
  assert.equal(blockedIssue.blockerKind, "completion_blocked");
  assert.equal(blockedIssue.reason, "完成检查未通过");

  const uncertain = snapshot("paused");
  uncertain.uncertainWrite = { toolCallId: "call-1", message: "写入结果未知", createdAt: at };
  const uncertainIssue = buildProductDiagnostics(product(), environment, uncertain)[0]!.issue;
  assert.equal(uncertainIssue.state, "uncertain_write");
  assert.equal(uncertainIssue.source, "entry");
});

test("自动录入失败优先于任务投影，任务异常作为兜底", () => {
  const entry = product();
  entry.automation = { id: "a1", status: "failed", currentPhase: "hotelResource", updatedAt: at,
    phases: [{ phase: "hotelResource", status: "failed" }], logs: [{ at, message: "酒店保存失败", level: "error" }] };
  const issue = buildProductDiagnostics(entry, environment, undefined, task("needs_attention", "任务也失败"))[0]!.issue;
  assert.deepEqual({ source: issue.source, state: issue.state, stage: issue.stage, reason: issue.reason },
    { source: "entry", state: "failed", stage: "hotelResource", reason: "酒店保存失败" });
  const fallback = buildProductDiagnostics(product(), environment, undefined, task("needs_attention", "调度中断"))[0]!.issue;
  assert.equal(fallback.state, "blocked");
  assert.equal(fallback.reason, "调度中断");
});
