import test from "node:test";
import assert from "node:assert/strict";
import { prepareAutomationResumeRun } from "../../src/main/automation/automation.main/automation.main.resume-state.js";

function failed(error = "拼小团价格库存回读不一致：364/365 个日期精确匹配；异常日期：2027-10-02"): any {
  return {id: "run", status: "failed", logs: [], phases: [
    "basic", "presentation", "itinerary", "package", "pricingInventory", "hotelResource", "terms", "preflight",
  ].map(phase => ({phase, status: phase === "preflight" ? "failed" : "completed"})),
  recovery: {phases: {preflight: {phase: "preflight", state: "needs_user", finalError: error, attempts: []}}}};
}

test("跨日价格预检缺失仅修复价格并重新预检，保持酒店和条款完成", () => {
  const previous = failed();
  const phases = previous.phases.map((item: any) => item.phase);
  const resumed = prepareAutomationResumeRun(previous, phases, "pricingInventory");
  assert.deepEqual(resumed.phases.filter(item => item.status === "pending").map(item => item.phase),
    ["pricingInventory", "preflight"]);
  assert.equal(resumed.id, previous.id);
  assert.equal(previous.status, "failed");
  assert.equal(previous.phases.find((item: any) => item.phase === "pricingInventory").status, "completed");
});

test("其他预检失败不允许重写已完成的价格库存", () => {
  const previous = failed("酒店资源不一致");
  assert.throws(() => prepareAutomationResumeRun(previous, previous.phases.map((item: any) => item.phase),
    "pricingInventory"), /不是失败状态/);
});
