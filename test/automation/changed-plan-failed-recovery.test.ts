import assert from "node:assert/strict";
import test from "node:test";
import { prepareFailedRunChangedPlanRecovery } from "../../src/main/automation/automation.main/changed-plan-phase-recovery.js";
import { entryPhaseInputFingerprint } from "../../src/main/application/product-entry-phase-fingerprint.js";
import { preparePhaseRetry } from "../../src/main/automation/phase-retry.js";
import type { AutomationRun, ProductDetail } from "../../src/shared/contracts.js";

const PHASES = ["basic", "presentation", "itinerary", "package", "preflight"];

function plan() {
  return {
    sales: { productForm: "privateTour" },
    basicInfo: { days: 2, meetingCity: "拉萨" },
    presentation: { recommendation: "原推荐语" },
    itinerary: [{ day: 1, spots: [
      { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 76348 },
      { name: "冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 },
    ] }],
  } as Record<string, any>;
}

/** 基本信息、图文已按 savedPlan 回读完成，行程阶段失败。 */
function failedDetail(savedPlan: Record<string, any>, currentPlan: Record<string, any>): ProductDetail {
  const automation: AutomationRun = {
    id: "run", status: "failed", currentPhase: "itinerary", logs: [],
    phases: [
      { phase: "basic", status: "completed", inputFingerprint: entryPhaseInputFingerprint(savedPlan, "basic") },
      { phase: "presentation", status: "completed", inputFingerprint: entryPhaseInputFingerprint(savedPlan, "presentation") },
      { phase: "itinerary", status: "failed" },
      { phase: "package", status: "pending" },
      { phase: "preflight", status: "pending" },
    ],
  };
  return { id: "p", productId: "1", product: currentPlan, automation } as unknown as ProductDetail;
}

test("失败后规划未改动断点前的输入：按普通断点从失败阶段继续", () => {
  assert.equal(prepareFailedRunChangedPlanRecovery(failedDetail(plan(), plan()), PHASES, "itinerary"), undefined);
});

test("失败后改了每日行程：基本信息依赖行程景点，从 basic 起全部重跑", () => {
  const current = plan();
  current.itinerary[0].spots.pop();
  const result = prepareFailedRunChangedPlanRecovery(failedDetail(plan(), current), PHASES, "itinerary", "t")!;
  assert.equal(result.retryFrom, "basic");
  assert.equal(result.run.currentPhase, "basic");
  assert.ok(result.run.phases.every((item) => item.status === "pending"));
  assert.match(result.run.logs.at(-1)!.message, /basic、presentation.*从 basic 起/);
});

test("失败后只改了图文：基本信息保持完成，从 presentation 起重跑", () => {
  const current = plan();
  current.presentation.recommendation = "新推荐语";
  const result = prepareFailedRunChangedPlanRecovery(failedDetail(plan(), current), PHASES, "itinerary", "t")!;
  assert.equal(result.retryFrom, "presentation");
  assert.deepEqual(result.run.phases.map((item) => [item.phase, item.status]), [
    ["basic", "completed"], ["presentation", "pending"], ["itinerary", "pending"], ["package", "pending"], ["preflight", "pending"],
  ]);
  assert.ok(result.run.phases[0]!.inputFingerprint, "保留下来的完成阶段要带着指纹");
});

test("断点重试保留已完成阶段的输入指纹，下一次重新规划仍能识别改动", () => {
  const detail = failedDetail(plan(), plan());
  const retried = preparePhaseRetry(detail.automation!, PHASES, "itinerary", "t");
  assert.equal(retried.phases[0]!.inputFingerprint, detail.automation!.phases[0]!.inputFingerprint);
  assert.equal(retried.phases[1]!.inputFingerprint, detail.automation!.phases[1]!.inputFingerprint);
  const changed = plan();
  changed.itinerary[0].spots.pop();
  const again = prepareFailedRunChangedPlanRecovery(
    { ...detail, product: changed, automation: { ...retried, status: "failed" } } as ProductDetail, PHASES, "itinerary");
  assert.equal(again?.retryFrom, "basic");
});

test("没有指纹的历史完成阶段不臆测改动", () => {
  const detail = failedDetail(plan(), { ...plan(), itinerary: [] });
  for (const item of detail.automation!.phases) delete item.inputFingerprint;
  assert.equal(prepareFailedRunChangedPlanRecovery(detail, PHASES, "itinerary"), undefined);
});
