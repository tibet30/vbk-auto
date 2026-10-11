import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { DraftAutomation } from "../../src/main/automation/automation.main/automation.main.class.js";
import { runExclusive } from "../../src/main/automation/automation.main/automation.main.class/runners.js";
import { makeAutomationRunContext } from "../../src/main/automation/automation.main/automation.main.make-context.js";
import { automationSession, executeDraftPhase, recoverDraftPhase } from "../../src/main/automation/automation.main/runtime/index.js";
import { runAutomationExclusive } from "../../src/main/automation/automation.main/automation.main.execution.js";
import type { AutomationRunContext } from "../../src/main/automation/automation.main/automation.main.context.js";
import type { AutomationRun } from "../../src/shared/contracts.js";
import type { VbkBrowser } from "../../src/main/infrastructure/vbk-browser.js";
import { productSectionUrl } from "../../src/main/automation/constants.js";
import { runOnePhase } from "../../src/main/automation/automation.main/automation.main.run-one.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "vbk-automation-runtime-"));
  const db = new VbkDatabase(directory);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const product = db.createProduct({ destination: "成都", days: 1, productForm: "groupTour" });
  db.setProductId(product.id, "123");
  const run: AutomationRun = { id: "runtime", status: "running", logs: [], phases: [
    { phase: "basic", status: "completed" }, { phase: "terms", status: "pending" }, { phase: "preflight", status: "pending" } ] };
  const sources: string[] = [];
  const page = { nativeOnly: true, withRequestSource: async (url: string, task: () => Promise<unknown>) => { sources.push(url); return task(); } };
  const browser = { isVisible: () => false, navigate: async () => {}, requestPage: async () => page } as unknown as VbkBrowser;
  const coordinator = new ProductWorkflowCoordinator();
  const ctx = makeAutomationRunContext({ db, browser, emit: () => {}, cancellationRequested: new Set(),
    exclusive: task => coordinator.runVbkPageExclusive(task),
    advisor: async () => ({ summary: "retry", rootCause: "timeout", expectedEvidence: "readback", action: "retry_same_phase" }) });
  const session = automationSession(ctx, product.id, run);
  const execution = { ctx, localProductId: product.id, run, page: page as never,
    productId: "123", manualCover: false, ...session };
  return { db, product, run, ctx, session, execution, sources, browser, coordinator };
}

test("shared phase execution saves recoverable failures and verified completion into real SQLite", async t => {
  const { db, product, run, execution, session, sources } = fixture(t);
  let calls = 0;
  const outcome = await recoverDraftPhase(execution, "terms", true,
    () => executeDraftPhase(execution, "terms", async () => { if (++calls === 1) throw Error("transient save failure"); }));
  assert.equal(outcome.status, "completed");
  const saved = db.getProduct(product.id)!.automation!;
  assert.equal(saved.phases[1].status, "completed");
  assert.equal(saved.recovery!.phases.terms.attempts.length, 1);
  assert.equal(saved.recovery!.phases.terms.state, "completed");
  assert.equal(saved.phases[2].status, "pending");
  assert.equal(calls, 2);
  assert.ok(sources.length > 0);
  assert.ok(sources.every(url => url === productSectionUrl("123", "terms")));
  session.fail(new Error("preflight readback missing"), "preflight");
  const failed = db.getProduct(product.id)!;
  assert.equal(failed.status, "blocked");
  assert.equal(failed.automation!.recovery!.phases.preflight.finalError, "preflight readback missing");
  assert.equal(failed.automation!.phases[1].status, "completed");
  assert.equal(run.status, "failed");
});

test("facade forwards its injected shared page queue and write guard to execution context", async t => {
  const { db, product, browser, coordinator } = fixture(t);
  const events: string[] = [];
  const automation = new DraftAutomation(db, browser, () => {}, async () => ({}) as never);
  automation.setRunVbkPageExclusive(task => coordinator.runVbkPageExclusive(task));
  automation.setAgentWriteGuard(async () => { events.push("guard"); });
  const ctx = (automation as unknown as { runContext(id: string): AutomationRunContext }).runContext(product.id);
  let release!: () => void;
  const first = coordinator.runVbkPageExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const second = ctx.runVbkPageExclusive(async () => { events.push("write"); }, "terms");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["guard", "write"]);
});

test("stop while waiting for page ownership prevents the queued platform write", async t => {
  const { execution, coordinator, ctx, product } = fixture(t);
  let release!: () => void;
  const first = coordinator.runVbkPageExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let written = false;
  const second = recoverDraftPhase(execution, "terms", true,
    () => executeDraftPhase(execution, "terms", async () => { written = true; }));
  ctx.cancellationRequested.add(product.id);
  release();
  await first;
  assert.equal((await second).status, "cancelled");
  assert.equal(written, false);
});

test("clock initialization and navigation pin failures release product ownership", async t => {
  const running = new Set<string>();
  const cancellationRequested = new Set<string>();
  await assert.rejects(runAutomationExclusive({ localProductId: "p", running, cancellationRequested,
    clock: { setEnabled: () => { throw Error("clock unavailable"); } } as never, work: async () => {} }), /clock unavailable/);
  assert.equal(running.size, 0);
  const { db, product, browser } = fixture(t);
  let cleared = 0;
  browser.pinProductNavigation = () => { throw Error("pin unavailable"); };
  browser.clearNavigationPin = () => { cleared++; };
  await assert.rejects(runExclusive({ db, browser, running, cancellationRequested,
    onUpdate: () => {}, advisor: async () => ({}) as never }, product.id, async () => {}), /pin unavailable/);
  assert.equal(running.size, 0);
  assert.equal(cleared, 1);
});

test("traffic backfill holds ownership through preflight and a stop never starts preflight", async t => {
  const { db, product, browser, run } = fixture(t);
  const automation = new DraftAutomation(db, browser, () => {}, async () => ({}) as never);
  const phases: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const internal = automation as unknown as {
    runApprovedBackfillLocked(id: string): Promise<void>;
    runOnePhase(id: string, phase: string): Promise<void>;
  };
  internal.runOnePhase = async (id, phase) => {
    phases.push(phase);
    await held;
    run.status = "cancelled";
    db.saveAutomation(id, run);
  };
  const backfill = internal.runApprovedBackfillLocked(product.id);
  await assert.rejects(automation.retryPhase(product.id, "terms"), /正在进行中/);
  release();
  await assert.rejects(backfill, /用户中止/);
  assert.deepEqual(phases, ["trafficLine"]);
});

test("request-surface acquisition failure preserves the previous persisted checkpoint", async t => {
  const { db, product, ctx, run } = fixture(t);
  Object.assign(product.product.basicInfo!, { subtitle: "成都游览", province: "四川", operationNotes: "按行程安排" });
  Object.assign(product.product.operations!, { pickupCity: "成都" });
  product.product.itinerary = [{ day: 1, title: "成都", spots: [], description: "游览", hotel: "", meals: "自理" }];
  db.updateProduct(product.id, product.product, "blocked");
  db.setBasicInfoSaved(product.id);
  run.status = "failed";
  run.phases[1].status = "failed";
  db.saveAutomation(product.id, run);
  const before = db.getProduct(product.id)!.automation;
  ctx.browser.requestPage = async () => { throw Error("session disconnected"); };
  await assert.rejects(runOnePhase(ctx, product.id, "terms"), /session disconnected/);
  assert.deepEqual(db.getProduct(product.id)!.automation, before);
});
