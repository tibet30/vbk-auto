import assert from "node:assert/strict";
import test from "node:test";
import { automationBlockedByPoiRisk, reopenAutomationAfterPoiRemoval } from "../../src/main/automation/automation.main/poi-removal-reopen.js";
import { failedAutomationResumePhase } from "../../src/main/automation/automation.main/automation.main.resume-phase.js";
import { preparePhaseRetry } from "../../src/main/automation/phase-retry.js";
import type { AutomationRun } from "../../src/shared/contracts.js";

const RISK = "行程审核需要用户决定：VBK 不接受结构化 POI「冈仁波齐」与「境内短途旅游」的组合。\n平台原始原因：行程审核校验失败（Ack=Failure）：数据风险，原因：POI：冈仁波齐 且 产品类型：境内短途旅游，请修改后重新操作";
const PHASES = ["basic", "presentation", "itinerary", "package", "preflight"];

function blockedRun(): AutomationRun {
  return {
    id: "run", status: "failed", currentPhase: "itinerary",
    phases: [
      { phase: "saleControl", status: "completed" },
      { phase: "basic", status: "completed", inputFingerprint: "a" },
      { phase: "presentation", status: "completed", inputFingerprint: "b" },
      { phase: "itinerary", status: "failed" },
      { phase: "package", status: "pending" },
      { phase: "preflight", status: "pending" },
    ],
    logs: [],
    recovery: { phases: {
      saleControl: { phase: "saleControl", state: "completed", attempts: [] },
      itinerary: { phase: "itinerary", state: "needs_user", attempts: [], finalError: RISK },
    } },
  } as AutomationRun;
}

test("剔除风险 POI 后从基本信息起重录，保留产品壳", () => {
  const reopened = reopenAutomationAfterPoiRemoval(blockedRun(), "冈仁波齐", "t")!;
  assert.equal(reopened.currentPhase, "basic");
  assert.deepEqual(reopened.phases.map((item) => [item.phase, item.status]), [
    ["saleControl", "completed"], ["basic", "failed"], ["presentation", "pending"],
    ["itinerary", "pending"], ["package", "pending"], ["preflight", "pending"],
  ]);
  assert.ok(reopened.phases.every((item) => item.phase === "saleControl" || !item.inputFingerprint));
  assert.deepEqual(Object.keys(reopened.recovery!.phases), ["saleControl"]);
  assert.match(reopened.logs.at(-1)!.message, /冈仁波齐.*基本信息起重新录入/);
  // 断点重试据此从 basic 开始，后续栏目全部重做。
  assert.equal(failedAutomationResumePhase(reopened), "basic");
  const retry = preparePhaseRetry(reopened, PHASES, "basic", "t");
  assert.ok(retry.phases.every((item) => item.status === "pending"));
});

test("只有远端仍停在同一 POI 数据风险时才认定为需重录", () => {
  assert.equal(automationBlockedByPoiRisk(blockedRun(), "冈仁波齐"), true);
  assert.equal(automationBlockedByPoiRisk(blockedRun(), "玛旁雍措"), false);
  assert.equal(automationBlockedByPoiRisk({ ...blockedRun(), status: "succeeded" }, "冈仁波齐"), false);
  assert.equal(reopenAutomationAfterPoiRemoval(undefined, "冈仁波齐"), undefined);
  assert.equal(reopenAutomationAfterPoiRemoval({ ...blockedRun(), phases: [{ phase: "saleControl", status: "failed" }] }, "冈仁波齐"), undefined);
});
