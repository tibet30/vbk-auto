import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runSaleControlPhase } from "../../src/main/automation/automation.main/automation.main.run-sale-control.js";
import { DraftAutomation } from "../../src/main/automation/automation.main/automation.main.js";
import { draftPhasesFor } from "../../src/main/automation/automation.main/automation.main.phases.js";
import { prepareSaleControlRetry } from "../../src/main/automation/phase-retry.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";
import type { AutomationRun, ProjectDetail } from "../../src/shared/contracts.js";
import type { VbkBrowser } from "../../src/main/infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

function makeProduct() {
  return parseProduct({
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "销售控制重试测试",
      supplierProductCode: "SALE-CONTROL-RETRY-1",
      subtitle: "销售控制重试",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试",
    },
    itinerary: [{ day: 1, title: "太原", spots: [], description: "市区游", hotel: "", meals: "自理" }],
  });
}

function makeRun(status: AutomationRun["status"] = "failed"): AutomationRun {
  return {
    id: "run-sale-control",
    status,
    phases: [
      { phase: "basic", status: "pending" },
      { phase: "presentation", status: "pending" },
      { phase: "preflight", status: "pending" },
    ],
    logs: [],
  };
}

function makeProject(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: "project-sale-control",
    name: "销售控制重试",
    status: "blocked",
    updatedAt: "2026-08-12T00:00:00.000Z",
    product: makeProduct(),
    messages: [],
    researchTasks: [],
    automation: makeRun(),
    ...overrides,
  };
}

function makeContext(project: ProjectDetail) {
  const savedRuns: AutomationRun[] = [];
  const lifecycleUpdates: Array<Record<string, unknown>> = [];
  const db = {
    getProject: () => project,
    saveAutomation: (_projectId: string, run: AutomationRun) => savedRuns.push(run),
    setProjectLifecycle: (_projectId: string, updates: Record<string, unknown>) => {
      lifecycleUpdates.push(updates);
      if (updates.productId !== undefined) project.productId = String(updates.productId);
      if (updates.status !== undefined) project.status = updates.status as ProjectDetail["status"];
    },
  } as unknown as VbkDatabase;
  const browser = {
    setVisible: () => undefined,
    page: async () => ({ url: () => "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge" }),
  } as unknown as VbkBrowser;

  return {
    ctx: {
      db,
      browser,
      advisor: async () => ({ action: "wait_for_user" as const, reasoning: "test" }),
      resolveActiveButlerContext: () => null,
      emit: () => undefined,
      markCancelled: (_projectId: string, run: AutomationRun, persist: () => void) => {
        run.status = "cancelled";
        persist();
      },
      cancellationRequested: new Set<string>(),
      ensureBrowserHasBounds: () => undefined,
    },
    savedRuns,
    lifecycleUpdates,
  };
}

test("无 productId 且有 automation 记录：销售控制重试复用壳配置并落到可观察终态", async () => {
  const project = makeProject();
  const { ctx, savedRuns, lifecycleUpdates } = makeContext(project);
  let configureCalls = 0;

  await runSaleControlPhase(ctx, project.id, async (_page, product) => {
    configureCalls += 1;
    assert.equal(product.basicInfo.supplierProductCode, "SALE-CONTROL-RETRY-1");
    return "76543210";
  });

  assert.equal(configureCalls, 1);
  assert.equal(project.productId, "76543210");
  assert.equal(project.status, "draft_saved");
  const finalRun = savedRuns.at(-1)!;
  assert.equal(finalRun.status, "succeeded");
  assert.equal(finalRun.currentPhase, undefined);
  assert.equal(finalRun.phases.some((phase) => phase.phase === "saleControl"), false);
  assert.equal(finalRun.recovery?.phases.saleControl.state, "completed");
  assert.match(finalRun.logs.at(-1)?.message ?? "", /productId 已保存/);
  assert.ok(lifecycleUpdates.some((updates) => updates.productId === "76543210"));
});

test("已有 productId：入口在创建前明确阻断，避免重复创建第二个产品", async () => {
  const project = makeProject({ productId: "already-created" });
  const { ctx } = makeContext(project);
  let configureCalls = 0;

  await assert.rejects(
    () => runSaleControlPhase(ctx, project.id, async () => {
      configureCalls += 1;
      return "should-not-create";
    }),
    /已有 productId.*不能重新执行销售控制/,
  );
  assert.equal(configureCalls, 0);
});

test("prepareSaleControlRetry 不向 draft phases 添加 saleControl", () => {
  const next = prepareSaleControlRetry(makeRun(), "2026-08-12T01:00:00.000Z");
  assert.equal(next.currentPhase, "saleControl");
  assert.equal(next.recovery?.phases.saleControl.state, "running");
  assert.deepEqual(next.phases.map((phase) => phase.phase), ["basic", "presentation", "preflight"]);
  assert.equal(draftPhasesFor(makeProduct()).includes("saleControl"), false);
});

test("retryOnePhase saleControl：无 productId 时走现有互斥入口，running 时阻断", async () => {
  const project = makeProject();
  const db = { getProject: () => project } as unknown as VbkDatabase;
  const browser = {} as VbkBrowser;
  const automation = new DraftAutomation(db, browser, () => undefined, async () => ({ action: "wait_for_user", reasoning: "test" }));
  let calls = 0;
  (automation as unknown as { runSaleControl: () => Promise<void> }).runSaleControl = async () => { calls += 1; };

  await automation.retryOnePhase(project.id, "saleControl");
  assert.equal(calls, 1);

  project.automation = makeRun("running");
  await assert.rejects(() => automation.retryOnePhase(project.id, "saleControl"), /正在进行中/);
});

test("销售控制重执行进行中：同一项目的第二次 retryOnePhase 共享现有互斥并阻断", async () => {
  const project = makeProject();
  const db = { getProject: () => project } as unknown as VbkDatabase;
  const automation = new DraftAutomation(db, {} as VbkBrowser, () => undefined, async () => ({ action: "wait_for_user", reasoning: "test" }));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  (automation as unknown as { runSaleControl: () => Promise<void> }).runSaleControl = async () => hold;

  const first = automation.retryOnePhase(project.id, "saleControl");
  await Promise.resolve();
  await assert.rejects(() => automation.retryOnePhase(project.id, "saleControl"), /正在进行中/);
  release();
  await first;
});

test("销售控制行提供重执行入口，但仍保持空 phaseNames 的 done 聚合设计", () => {
  const source = readFileSync("src/renderer/app/views/workspace/vbk.tsx", "utf8");
  assert.match(source, /section\.key === "saleControl" \? \["saleControl"\] : section\.phaseNames/);
  assert.match(source, /retryPhases\.map\(\(phaseKey\)/);
  assert.match(source, /disabled=\{!!retryingPhase \|\| !url \|\| isNavigating \|\| automationActive \|\| saleControlRequiresNoProduct\}/);
});
