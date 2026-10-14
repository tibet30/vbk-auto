import assert from "node:assert/strict";
import test from "node:test";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { handoffWizardStageRetry } from "../../src/main/agent/integration-setup/wizard-stage-retry.js";
import type { AgentApproval, AgentSnapshot } from "../../src/shared/contracts.js";

function approval(phase: "basic" | "presentation", alreadyAdvanced = false): AgentApproval {
  return {
    id: `approval-${phase}`,
    status: "approved",
    scope: [`vbk.write_phase:${phase}`],
    accountKey: "account",
    productVersion: "version",
    summary: "限定当前向导页的官方下一步。",
    createdAt: "2026-10-14T00:00:00.000Z",
    intentVersion: "intent",
    wizardStageRetry: { phase, alreadyAdvanced },
  };
}

function runningSnapshot(current: AgentApproval): AgentSnapshot {
  return {
    localProductId: "local-product",
    run: {
      id: "run", status: "running", intentVersion: "intent",
      createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
    },
    events: [{
      id: "approval-event", runId: "run", type: "approval", content: "确认", createdAt: "2026-10-14T00:00:00.000Z",
      data: { approval: current },
    }],
  };
}

test("窄范围向导确认只排队执行相同页面的官方下一步，然后完成本次请求", async () => {
  const current = approval("basic");
  const calls: string[] = [];
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const context = {
    productWorkflows: new ProductWorkflowCoordinator(),
    db: { getAgentSnapshot: () => runningSnapshot(current) },
    automation: {
      executeApprovedWizardStage: async (id: string, phase: string) => {
        calls.push(`write:${id}:${phase}`);
      },
    },
    agentCore: {
      completeApprovedWorkflow: async (id: string, approvalId: string) => {
        calls.push(`complete:${id}:${approvalId}`);
        complete();
      },
      pauseApprovedWorkflow: async (_id: string, message: string) => assert.fail(message),
    },
  };

  assert.equal(handoffWizardStageRetry(context as any, "local-product", current), true);
  await done;
  assert.deepEqual(calls, ["write:local-product:basic", "complete:local-product:approval-basic"]);
});

test("已越过菜单的重试只完成只读请求，不排队或调用写入", async () => {
  const current = approval("presentation", true);
  const calls: string[] = [];
  const context = {
    productWorkflows: new ProductWorkflowCoordinator(),
    db: { getAgentSnapshot: () => runningSnapshot(current) },
    automation: {
      executeApprovedWizardStage: async () => calls.push("write"),
    },
    agentCore: {
      completeApprovedWorkflow: async (id: string, approvalId: string) => {
        calls.push(`complete:${id}:${approvalId}`);
      },
      pauseApprovedWorkflow: async (_id: string, message: string) => assert.fail(message),
    },
  };

  assert.equal(handoffWizardStageRetry(context as any, "local-product", current), true);
  await Promise.resolve();
  assert.deepEqual(calls, ["complete:local-product:approval-presentation"]);
});
