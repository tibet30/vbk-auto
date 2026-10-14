import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import {
  formatWizardStageRetryInstruction,
  parseWizardStageRetryInstruction,
} from "../../src/shared/wizard-stage-retry.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";
import type { WizardStageRetryPhase } from "../../src/shared/wizard-stage-retry.js";

type Plan = {
  scope: string[];
  summary: string;
  phase: WizardStageRetryPhase;
  alreadyAdvanced: boolean;
};

function fixture(plan: Plan, precondition?: string) {
  let sequence = 0;
  let modelCalls = 0;
  let handoffs = 0;
  const prepared: WizardStageRetryPhase[] = [];
  let saved: AgentSnapshot = {
    localProductId: "product",
    run: { id: "old-run", status: "paused", createdAt: "before", updatedAt: "before" },
    events: [],
  };
  const deps: AgentCoreDependencies = {
    tools: [],
    id: () => `id-${++sequence}`,
    model: { complete: async () => { modelCalls += 1; throw new Error("model must not run"); } },
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    approvalPrecondition: async () => precondition,
    prepareWizardStageRetry: async (_id, phase) => {
      prepared.push(phase);
      return plan;
    },
    handoffApprovedWorkflow: () => { handoffs += 1; return true; },
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => structuredClone(saved),
    saveAgentSnapshot: value => { saved = structuredClone(value); },
  });
  return {
    core,
    prepared: () => prepared,
    modelCalls: () => modelCalls,
    handoffs: () => handoffs,
    snapshot: () => saved,
  };
}

test("产品信息重新执行创建独立的窄范围最终确认，不调用模型", async () => {
  const f = fixture({
    scope: ["vbk.write_phase:basic"],
    summary: "已核验基础信息，确认后仅调用基础信息官方下一步。",
    phase: "basic",
    alreadyAdvanced: false,
  });

  const next = await f.core.send("product", formatWizardStageRetryInstruction("basic"));

  assert.deepEqual(f.prepared(), ["basic"]);
  assert.notEqual(next.run?.id, "old-run");
  assert.equal(next.run?.status, "waiting_approval");
  assert.deepEqual(next.pendingApproval?.scope, ["vbk.write_phase:basic"]);
  assert.deepEqual(next.pendingApproval?.wizardStageRetry, { phase: "basic", alreadyAdvanced: false });
  assert.equal(next.events.some(event => event.type === "approval_request"), true);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.handoffs(), 0);
});

test("已越过向导阶段时完成只读核验，不生成授权或调用下一步", async () => {
  const f = fixture({
    scope: [],
    summary: "远端菜单已进入行程描述，产品图文无需重复提交。",
    phase: "presentation",
    alreadyAdvanced: true,
  });

  const next = await f.core.send("product", formatWizardStageRetryInstruction("presentation"));

  assert.deepEqual(f.prepared(), ["presentation"]);
  assert.equal(next.run?.status, "completed");
  assert.equal(next.pendingApproval, undefined);
  assert.equal(next.events.some(event => event.type === "approval_request"), false);
  assert.equal(next.events.some(event => event.content.includes("不重复调用下一步")), true);
  assert.equal(next.events.some(event => event.content.includes("远端菜单已进入行程描述")), true);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.handoffs(), 0);
});

test("阶段重试在前置检查不通过时不改写既有运行或创建授权", async () => {
  const f = fixture({
    scope: ["vbk.write_phase:basic"], summary: "基础信息", phase: "basic", alreadyAdvanced: false,
  }, "当前账号未通过核验");

  await assert.rejects(f.core.send("product", formatWizardStageRetryInstruction("basic")), /当前账号未通过核验/);

  assert.equal(f.snapshot().run?.id, "old-run");
  assert.equal(f.snapshot().pendingApproval, undefined);
  assert.equal(f.modelCalls(), 0);
});

test("仅识别由重试按钮生成的精确指令", () => {
  assert.equal(parseWizardStageRetryInstruction(formatWizardStageRetryInstruction("basic")), "basic");
  assert.equal(parseWizardStageRetryInstruction(formatWizardStageRetryInstruction("presentation")), "presentation");
  assert.equal(parseWizardStageRetryInstruction("请重试基础信息阶段。"), undefined);
  assert.equal(parseWizardStageRetryInstruction("请检查并修复基础信息阶段，再继续录入。"), undefined);
});

test("适配器返回其它阶段的计划时拒绝创建超范围授权", async () => {
  const f = fixture({
    scope: ["vbk.write_phase:presentation"], summary: "不匹配", phase: "presentation", alreadyAdvanced: false,
  });

  await assert.rejects(f.core.send("product", formatWizardStageRetryInstruction("basic")), /计划无效/);

  assert.equal(f.snapshot().run?.id, "old-run");
  assert.equal(f.snapshot().pendingApproval, undefined);
  assert.equal(f.modelCalls(), 0);
});
