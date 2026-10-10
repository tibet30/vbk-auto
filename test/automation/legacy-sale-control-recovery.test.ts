import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationRun } from "../../src/shared/contracts.js";
import { failedAutomationResumePhase } from "../../src/main/automation/automation.main/automation.main.resume-phase.js";
import { recoverCreatedShell } from "../../src/main/automation/automation.main/automation.main.recover-shell.js";

function legacyRun(): AutomationRun {
  return { id: "legacy-shell", status: "failed", currentPhase: "saleControl",
    phases: [{ phase: "basic", status: "pending" }, { phase: "presentation", status: "pending" }],
    logs: [{ at: "2026-10-03T15:54:24Z", level: "error", message: "VBK 基本信息回读失败（Ack=Failure）：没有当前资源的权限" }] };
}

test("旧创建断点进入原草稿回读，而普通未知失败仍受阻", () => {
  assert.equal(failedAutomationResumePhase(legacyRun()), "saleControl");
  assert.equal(failedAutomationResumePhase({ ...legacyRun(), currentPhase: "basic" }), undefined);
  assert.equal(failedAutomationResumePhase({ ...legacyRun(), phases: [{ phase: "basic", status: "completed" }] }), undefined);
  assert.equal(failedAutomationResumePhase({ ...legacyRun(), logs: [{ at: "now", level: "error", message: "当前任务未处于可录入状态。" }] }), undefined);
});

test("缺少草稿编号时保留首次错误，不触发任何远端请求或写回", async () => {
  let verified = false;
  await assert.rejects(recoverCreatedShell({} as any, { id: "local", automation: legacyRun() } as any,
    async () => { verified = true; }), /未保存携程产品编号[\s\S]*首次失败：.*没有当前资源的权限/);
  assert.equal(verified, false);
});

test("已有编号只回读原草稿，回读失败不得标为完成", async () => {
  let saved: AutomationRun | undefined;
  const ctx = { browser: { requestPage: async () => ({}) },
    runVbkPageExclusive: async (work: () => Promise<void>) => work(),
    db: { saveAutomation: (_id: string, run: AutomationRun) => { saved = run; } }, emit: () => {} } as any;
  const product = { id: "local", productId: "79300001", product: {}, automation: legacyRun() } as any;
  await assert.rejects(recoverCreatedShell(ctx, product, async (_page, _product, id) => {
    assert.equal(id, "79300001");
    throw new Error("没有当前资源的权限");
  }), /没有当前资源的权限/);
  assert.equal(saved, undefined);
  await recoverCreatedShell(ctx, product, async (_page, _product, id) => { assert.equal(id, "79300001"); });
  assert.equal(saved?.status, "queued");
  assert.equal(saved?.recovery?.phases.saleControl.state, "completed");
  assert.deepEqual(saved?.phases.map(phase => phase.status), ["pending", "pending"]);
});
