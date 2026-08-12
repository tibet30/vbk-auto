import test from "node:test";
import assert from "node:assert/strict";
import { DraftAutomation } from "../../src/main/automation/automation.main/automation.main.js";
import { assertSinglePhaseRetryPrerequisites } from "../../src/main/automation/automation.main/automation.main.prerequisites.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";
import type { AutomationRun, ProjectDetail } from "../../src/shared/contracts.js";
import type { VbkBrowser } from "../../src/main/infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

const pricing = { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 };
const inventory = { startDate: "2026-09-01", endDate: "2026-09-30", dailyQuota: 10 };

function makeProduct(commercial?: Record<string, unknown>) {
  return parseProduct({
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原1日跟团游",
      supplierProductCode: "TEST-RETRY-PRICE-1",
      subtitle: "太原经典一日游",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试",
    },
    commercial,
    itinerary: [
      {
        day: 1,
        title: "太原市区游",
        spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
        description: "游览晋祠博物馆。",
        hotel: "",
        meals: "早餐自理；午餐自理；晚餐自理",
      },
    ],
  });
}

function makeRun(): AutomationRun {
  return {
    id: "run-1",
    status: "failed",
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "package", status: "completed" },
      { phase: "pricingInventory", status: "failed" },
      { phase: "preflight", status: "pending" },
    ],
    currentPhase: "pricingInventory",
    logs: [],
    recovery: { phases: { pricingInventory: { phase: "pricingInventory", state: "needs_user", attempts: [] } } },
  };
}

function makeProject(product: Record<string, unknown>): ProjectDetail {
  return {
    id: "project-1",
    name: "太原测试",
    status: "blocked",
    productId: "7654321",
    updatedAt: "2026-08-12T00:00:00.000Z",
    product,
    messages: [],
    researchTasks: [],
    automation: makeRun(),
    basicInfoSaved: true,
  };
}

function makeAutomation(project: ProjectDetail) {
  let saveAutomationCalls = 0;
  const db = {
    getProject: () => project,
    saveAutomation: () => { saveAutomationCalls += 1; },
  } as unknown as VbkDatabase;
  const browser = {
    setVisible: () => undefined,
    page: async () => {
      throw new Error("browser should not be opened");
    },
  } as unknown as VbkBrowser;
  const automation = new DraftAutomation(db, browser, () => undefined, async () => ({ action: "wait_for_user", reasoning: "test" }));
  return {
    automation,
    saveAutomationCalls: () => saveAutomationCalls,
  };
}

test("pricingInventory 单阶段重试：缺 inventory 时入口直接抛错且不保存新 run", async () => {
  const project = makeProject(makeProduct({ packageName: "标准套餐", pricing }));
  const { automation, saveAutomationCalls } = makeAutomation(project);
  let runOnePhaseCalls = 0;
  (automation as unknown as { runOnePhase: () => Promise<void> }).runOnePhase = async () => { runOnePhaseCalls += 1; };

  await assert.rejects(
    () => automation.retryOnePhase(project.id, "pricingInventory"),
    /commercial\.inventory|班期库存/,
  );
  assert.equal(runOnePhaseCalls, 0);
  assert.equal(saveAutomationCalls(), 0);
});

test("pricingInventory 单阶段重试：缺 pricing 时入口直接抛错且不保存新 run", async () => {
  const project = makeProject(makeProduct({ packageName: "标准套餐", inventory }));
  const { automation, saveAutomationCalls } = makeAutomation(project);
  let runOnePhaseCalls = 0;
  (automation as unknown as { runOnePhase: () => Promise<void> }).runOnePhase = async () => { runOnePhaseCalls += 1; };

  await assert.rejects(
    () => automation.retryOnePhase(project.id, "pricingInventory"),
    /commercial\.pricing|套餐定价/,
  );
  assert.equal(runOnePhaseCalls, 0);
  assert.equal(saveAutomationCalls(), 0);
});

test("pricingInventory 单阶段重试：pricing 和 inventory 齐全时放行到原阶段执行", async () => {
  const project = makeProject(makeProduct({ packageName: "标准套餐", pricing, inventory }));
  const { automation, saveAutomationCalls } = makeAutomation(project);
  let runOnePhaseCalls = 0;
  (automation as unknown as { runOnePhase: () => Promise<void> }).runOnePhase = async () => { runOnePhaseCalls += 1; };

  await automation.retryOnePhase(project.id, "pricingInventory");
  assert.equal(runOnePhaseCalls, 1);
  assert.equal(saveAutomationCalls(), 0);
});

test("其它阶段不受 pricingInventory 前置校验影响", () => {
  const product = makeProduct({ packageName: "标准套餐", pricing });

  assert.doesNotThrow(() => assertSinglePhaseRetryPrerequisites(product, "package"));
});
