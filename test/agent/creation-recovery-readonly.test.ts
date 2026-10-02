import assert from "node:assert/strict";
import test from "node:test";

import { createVbkCreationRecoveryTools } from "../../src/main/agent/creation-recovery-readonly.ts";
import { needsTrafficLineBackfill } from "../../src/main/automation/traffic-line-backfill.ts";

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-product",
    name: "日喀则产品",
    status: "blocked",
    updatedAt: "2026-10-01T00:00:00.000Z",
    productId: "79189107",
    productJsonVersion: 7,
    basicInfoSaved: true,
    messages: [],
    researchTasks: [],
    product: {
      basicInfo: { meetingCity: "日喀则", destinationCity: "日喀则", days: 2, nights: 1 },
      sales: { productForm: "privateTour" },
      itinerary: [{ day: 1, hotel: "", spots: [] }, { day: 2, hotel: "", spots: [] }],
      commercial: { packageName: "日喀则套餐" },
      operations: { trafficLine: {
        enabled: true,
        variants: ["flightRoundTrip", "trainRoundTrip"],
        availability: {
          availableVariants: ["flightRoundTrip", "trainRoundTrip"],
          endpointPlan: {
            arrivalCity: "日喀则", departureCity: "日喀则", resolvedAt: "2026-10-01T00:00:00.000Z",
            flight: { arrival: { code: "RKZ", name: "日喀则机场" }, departure: { code: "RKZ", name: "日喀则机场" } },
            train: { arrival: { code: "RKO", name: "日喀则站" }, departure: { code: "RKO", name: "日喀则站" } },
          },
          unavailableVariants: {},
        },
      } },
    },
    automation: { id: "old-failed", status: "failed", phases: [{ phase: "trafficLine", status: "failed" }], logs: [] },
    ...overrides,
  } as any;
}

function harness(config: {
  mutateDuringRead?: boolean;
  mutateDiagnosticsDuringRead?: boolean;
  mutateBusinessAndDiagnosticsDuringRead?: boolean;
  mutateWorkflowDuringRead?: boolean;
  variant?: "draft" | "formal";
  verifiedPlan?: boolean;
  missingEndpointPlan?: boolean;
  trafficDisabled?: boolean;
  children?: any[];
  previousTrafficLine?: any;
} = {}) {
  let current = product();
  if (config.missingEndpointPlan) delete (current.product.operations as any).trafficLine.availability;
  if (config.trafficDisabled) (current.product.operations as any).trafficLine = { enabled: false, variants: [] };
  if (config.previousTrafficLine) {
    current.automation = { ...current.automation, trafficLine: config.previousTrafficLine };
  }
  const saved: any[] = [];
  const preflightIds: unknown[] = [];
  let childReads = 0;
  let childVerifications = 0;
  let writes = 0;
  const tools = createVbkCreationRecoveryTools({
    db: {
      getProduct: () => current,
      writeAutomationWithProductStatus: (_id: string, run: any, status: string) => {
        saved.push(run); current = { ...current, automation: run, status };
      },
    } as any,
    browser: { page: async () => ({}) } as any,
    productWorkflows: {
      runExclusive: async (_id: string, _work: string, task: () => Promise<unknown>) => task(),
      runVbkPageExclusive: async (task: () => Promise<unknown>) => task(),
    } as any,
    accountFor: async () => ({ accountKey: "vbk_account", productVersion: "version-7" }),
    readCreationVariant: async () => ({
      variant: config.variant ?? "draft",
      unsubmittedDraftVerified: config.verifiedPlan ?? true,
      ids: { draft: "79189107" },
      poi85862: { suffixName: "日喀则", description: "test" },
    }),
    readPreflight: async (_page: unknown, _product: unknown, _productId: string, options: unknown) => {
      preflightIds.push(options);
      if (config.mutateDiagnosticsDuringRead) {
        current = {
          ...current,
          productJsonVersion: (current.productJsonVersion ?? 0) + 1,
          product: { ...current.product, diagnostics: { runtime: { status: "running" } } },
        };
      }
      if (config.mutateDuringRead) {
        current = {
          ...current,
          productJsonVersion: (current.productJsonVersion ?? 0) + 1,
          product: { ...current.product, basicInfo: { ...current.product.basicInfo, destinationCity: "厦门" } },
        };
      }
      if (config.mutateBusinessAndDiagnosticsDuringRead) {
        current = {
          ...current,
          productJsonVersion: (current.productJsonVersion ?? 0) + 1,
          product: {
            ...current.product,
            basicInfo: { ...current.product.basicInfo, destinationCity: "厦门" },
            diagnostics: { runtime: { status: "running" } },
          },
        };
      }
      if (config.mutateWorkflowDuringRead) {
        current = {
          ...current,
          status: "review",
          automation: { ...current.automation, status: "succeeded" },
        };
      }
      return { productId: "79189107", verifiedWith: "remote-api-readback" };
    },
    readTrafficChildren: async () => {
      childReads += 1;
      return config.children ?? [
      { productId: "79194665", lineDescription: "飞机往返", packageId: "p1", active: true },
      { productId: "79194668", lineDescription: "火车往返", packageId: "p2", active: true },
      ];
    },
    verifyTrafficChild: async (_page: unknown, _parent: string, childId: string) => {
      childVerifications += 1;
      return {
      child: { productId: childId, lineDescription: childId === "79194665" ? "飞机往返" : "火车往返", active: true },
      tourInfoId: `tour-${childId}`, segmentCount: 1, departureCityCount: 1, transportNodes: 2, clauseCount: 4, presentationVerified: true,
      };
    },
    now: () => "2026-10-01T00:00:00.000Z",
    id: () => "test-run",
    // A write-shaped sentinel proves the factory has no dependency on an external mutation path.
    externalWrite: () => { writes += 1; },
  } as any);
  return {
    tool: tools[0]!, saved, preflightIds, current: () => current, externalWrites: () => writes,
    childReads: () => childReads, childVerifications: () => childVerifications,
  };
}

test("only persists a new recovery run after all readbacks verify", async () => {
  const { tool, saved, preflightIds, current, externalWrites } = harness();
  const result = await tool.execute({}, { localProductId: "local-product", accountKey: "", productVersion: "" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "readonly-recovery:test-run");
  assert.equal(saved[0].status, "succeeded");
  assert.ok(saved[0].phases.every((phase: any) => phase.status === "completed"));
  assert.ok(saved[0].trafficLine.children.every((child: any) => child.verified && child.completedStages.includes("finalReadback")));
  assert.equal(current().status, "draft_saved");
  assert.deepEqual(preflightIds, [{ itineraryTourInfoId: "79189107" }]);
  assert.equal(result.terminal, undefined);
  assert.match(result.content, /只读恢复已完成/);
  assert.equal(externalWrites(), 0);
});

test("fails closed without a verified draft variant and does not persist", async () => {
  const { tool, saved } = harness({ variant: "formal" });
  await assert.rejects(() => tool.execute({}, { localProductId: "local-product", accountKey: "", productVersion: "" }), /未提审草稿 variant/);
  assert.equal(saved.length, 0);
});

test("parent-only completes mother phases without reading or verifying traffic children", async () => {
  const previousTrafficLine = {
    endpointPlan: { arrivalCity: "日喀则", departureCity: "日喀则", resolvedAt: "2026-09-30T00:00:00.000Z" },
    verifiedAt: "2026-09-30T00:00:00.000Z",
    children: [{
      variant: "flightRoundTrip", lineDescription: "飞机往返", childProductId: "79194665",
      completedStages: ["planned", "childCreated"], verified: false, failedStage: "childCreated",
    }],
  };
  const { tool, saved, current, childReads, childVerifications } = harness({ previousTrafficLine });
  const result = await tool.execute({ scope: "parent-only" }, { localProductId: "local-product", accountKey: "", productVersion: "" });
  assert.equal(saved.length, 1);
  assert.ok(saved[0].phases.every((phase: any) => phase.phase !== "trafficLine" && phase.status === "completed"));
  assert.equal(saved[0].trafficLine.verifiedAt, undefined);
  assert.deepEqual(saved[0].trafficLine.children, previousTrafficLine.children);
  assert.equal(previousTrafficLine.verifiedAt, "2026-09-30T00:00:00.000Z");
  assert.equal(childReads(), 0);
  assert.equal(childVerifications(), 0);
  assert.deepEqual(result.data?.trafficLine, { scope: "parent-only", deferred: true, variants: ["flightRoundTrip", "trainRoundTrip"] });
  assert.equal(result.terminal, true);
  assert.equal(result.data?.automation.finalReadbackVerified, false);
  assert.equal(result.data?.automation.motherReadbackVerified, true);
  assert.equal(needsTrafficLineBackfill(current()), true);
});

test("parent-only still requires an explicitly verified independent draft", async () => {
  const { tool, saved, childReads, childVerifications } = harness({ variant: "formal" });
  await assert.rejects(
    () => tool.execute({ scope: "parent-only" }, { localProductId: "local-product", accountKey: "", productVersion: "" }),
    /未提审草稿 variant/,
  );
  assert.equal(saved.length, 0);
  assert.equal(childReads(), 0);
  assert.equal(childVerifications(), 0);
});

test("parent-only does not require traffic configuration or an endpoint plan", async () => {
  const { tool, saved, childReads, childVerifications } = harness({ trafficDisabled: true });
  const result = await tool.execute({ scope: "parent-only" }, { localProductId: "local-product", accountKey: "", productVersion: "" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].phases.some((phase: any) => phase.phase === "trafficLine"), false);
  assert.deepEqual(result.data?.trafficLine, { scope: "parent-only", deferred: true, variants: [] });
  assert.equal(childReads(), 0);
  assert.equal(childVerifications(), 0);
});

test("rejects duplicate traffic children instead of choosing one", async () => {
  const { tool, saved } = harness({ children: [
    { productId: "first", lineDescription: "飞机往返", active: true },
    { productId: "second", lineDescription: "飞机往返", active: true },
    { productId: "train", lineDescription: "火车往返", active: true },
  ] });
  await assert.rejects(() => tool.execute({}, { localProductId: "local-product", accountKey: "", productVersion: "" }), /无法唯一确认母子关系/);
  assert.equal(saved.length, 0);
});

test("does not persist when the endpoint plan was never verified", async () => {
  const { tool, saved } = harness({ missingEndpointPlan: true });
  await assert.rejects(() => tool.execute({}, { localProductId: "local-product", accountKey: "", productVersion: "" }), /已核验的大交通端点计划/);
  assert.equal(saved.length, 0);
});

test("rejects asynchronous product version changes before local checkpoint persistence", async () => {
  const { tool, saved } = harness({ mutateDuringRead: true });
  await assert.rejects(
    () => tool.execute({}, { localProductId: "local-product", accountKey: "", productVersion: "" }),
    (error: Error) => {
      assert.match(error.message, /流程版本已变化/);
      assert.match(error.message, /productJson/);
      return true;
    },
  );
  assert.equal(saved.length, 0);
});

test("permits diagnostics-only version bumps from agent or workflow mirrors", async () => {
  const { tool, saved } = harness({ mutateDiagnosticsDuringRead: true });
  const result = await tool.execute({ scope: "parent-only" }, { localProductId: "local-product", accountKey: "", productVersion: "" });
  assert.equal(saved.length, 1);
  assert.equal(result.data?.automation.scope, "parent-only");
});

test("rejects status or automation changes during the read", async () => {
  const { tool, saved } = harness({ mutateWorkflowDuringRead: true });
  await assert.rejects(
    () => tool.execute({ scope: "parent-only" }, { localProductId: "local-product", accountKey: "", productVersion: "" }),
    (error: Error) => {
      assert.match(error.message, /status\/automation\/trafficLine/);
      return true;
    },
  );
  assert.equal(saved.length, 0);
});

test("rejects a business edit even when diagnostics also changed", async () => {
  const { tool, saved } = harness({ mutateBusinessAndDiagnosticsDuringRead: true });
  await assert.rejects(
    () => tool.execute({ scope: "parent-only" }, { localProductId: "local-product", accountKey: "", productVersion: "" }),
    (error: Error) => {
      assert.match(error.message, /productJson/);
      return true;
    },
  );
  assert.equal(saved.length, 0);
});
