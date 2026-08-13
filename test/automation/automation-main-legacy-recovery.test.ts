/**
 * 历史 bug 恢复（recoverLegacyScreenshotFalseFailure）的行为测试。
 *
 * 场景：旧版 run.ts 把收尾 saveScreenshot 内联在主流程里，width=0 / page
 * detach 时整条 run 标 failed + 产品 blocked。automation:retry 因无
 * failed phase 退化为 start（全量重跑错误），retryPhase(preflight) 又被
 * preparePhaseRetry 拒绝。本恢复按"业务全部成功"切回 succeeded +
 * draft_saved，不重跑任何阶段。
 *
 * 验收门：
 *   L1 命中：所有 gate 满足 → run.status=succeeded, currentPhase=undefined,
 *      product.status=draft_saved, screenshot 重新尝试（warn-only）。
 *   L2 不命中（业务真失败）：任一 phase !== "completed" → 不恢复。
 *   L3 不命中（needs_user 还在）→ 绝不吞业务失败。
 *   L4 不命中（最后 error log 不是截图错误 / run.status 非 failed /
 *      productId 缺失）→ 不恢复。
 *   L5 截图再次失败：screenshot=undefined + warning + run 仍 succeeded。
 *   L6 互斥：产品 running 时不进入。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import type { VbkBrowser } from "../../src/main/infrastructure/vbk-browser.js";
import type { AutomationRun, AutomationRunContext } from "../../src/shared/contracts.js";
import {
  isLegacyScreenshotFalseFailure,
  recoverLegacyScreenshotFalseFailure,
} from "../../src/main/automation/automation.main/automation.main.legacy-recovery.js";

async function freshDb(t: test.TestContext) {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-legacy-recovery-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  return new VbkDatabase(dataPath);
}

/** 历史 bug 留下的 run：业务全 completed、run=failed、最后一条 error log 是截图错误。 */
function makeStuckRun(): AutomationRun {
  return {
    id: "run-stuck",
    status: "failed",
    currentPhase: undefined,
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "completed" },
      { phase: "itinerary", status: "completed" },
      { phase: "package", status: "completed" },
      { phase: "preflight", status: "completed" },
    ],
    logs: [
      { at: "2026-08-12T01:00:00.000Z", message: "正在保存：preflight", level: "info" },
      { at: "2026-08-12T01:01:00.000Z", message: "产品草稿已保存", level: "info" },
      { at: "2026-08-12T01:01:30.000Z", message: "Cannot take screenshot with 0 width", level: "error" },
    ],
  };
}

interface BrowserMock {
  browser: VbkBrowser;
  setVisibleCalls: boolean[];
  ensureBoundsCalls: number;
  pageCalls: number;
  ensureBrowserHasBounds: () => void;
}

function makeBrowserMock(opts: { page?: unknown } = {}): BrowserMock {
  const setVisibleCalls: boolean[] = [];
  const counters = { ensureBounds: 0, page: 0 };
  const page = opts.page ?? { id: "mock-page" };
  const browser = {
    setVisible(v: boolean) { setVisibleCalls.push(v); },
    view: { getBounds: () => ({ width: 0, height: 0 }) },
    setBounds() { /* noop mock */ },
    async page() { counters.page += 1; return page; },
  } as unknown as VbkBrowser;
  const ensureBrowserHasBounds = () => { counters.ensureBounds += 1; };
  return {
    browser,
    setVisibleCalls,
    // 用 getter 让外部读到的计数与 mock 内部闭包累加同源
    get ensureBoundsCalls() { return counters.ensureBounds; },
    get pageCalls() { return counters.page; },
    ensureBrowserHasBounds,
  };
}

function makeContext(
  db: VbkDatabase,
  browser: VbkBrowser,
  ensureBrowserHasBounds: () => void,
  emit: (id: string) => void,
): AutomationRunContext {
  return {
    db,
    browser,
    advisor: async () => { throw new Error("advisor 不应被调用"); },
    disambiguator: undefined,
    resolveActiveButlerContext: () => null,
    emit,
    markCancelled: () => undefined,
    cancellationRequested: new Set<string>(),
    ensureBrowserHasBounds,
  };
}

async function setupStuckProduct(db: VbkDatabase, run: AutomationRun) {
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  db.setProductId(product.id, "P-Ctrip-1");
  db.updateProduct(product.id, product.product, "blocked");
  db.saveAutomation(product.id, run);
  return product.id;
}

// ───────────────────────── L1: 命中 ─────────────────────────

test("L1 命中：业务全 completed + 截图错误 log → run=succeeded + 产品=draft_saved + 重新截图", async (t) => {
  const db = await freshDb(t);
  const localProductId = await setupStuckProduct(db, makeStuckRun());
  const browserMock = makeBrowserMock();
  const emitCalls: string[] = [];
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, (id) => emitCalls.push(id));
  const lock = makeLock();

  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, lock);
  assert.equal(recovered, true, "命中后必须返回 true");

  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "succeeded");
  assert.equal(after.automation!.currentPhase, undefined);
  // 业务阶段全部保留为 completed（不重跑）
  assert.ok(after.automation!.phases.every((p) => p.status === "completed"));
  assert.equal(after.status, "draft_saved");
  assert.deepEqual(browserMock.setVisibleCalls, [true]);
  assert.equal(browserMock.ensureBoundsCalls, 1);
  assert.equal(browserMock.pageCalls, 1);
  assert.ok(emitCalls.includes(localProductId));
  // 日志里有说明性 warning
  const messages = after.automation!.logs.map((l) => l.message);
  assert.ok(messages.some((m) => /历史截图失败遗留的失败记录/.test(m)));
});

test("L1 命中后 logs 末尾追加 warning 但旧 logs 全部保留", async (t) => {
  const db = await freshDb(t);
  const localProductId = await setupStuckProduct(db, makeStuckRun());
  const browserMock = makeBrowserMock();
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);
  await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
  const after = db.getProduct(localProductId)!;
  // 旧的 3 条 log 必须保留
  assert.equal(after.automation!.logs[0].message, "正在保存：preflight");
  assert.equal(after.automation!.logs[1].message, "产品草稿已保存");
  assert.equal(after.automation!.logs[2].message, "Cannot take screenshot with 0 width");
  // 末尾追加 warning
  const tail = after.automation!.logs.at(-1)!;
  assert.equal(tail.level, "warning");
  assert.match(tail.message, /未提交审核/);
});

// ───────────────────────── L5: 截图再次失败仍成功 ─────────────────────────

test("L5 截图再次失败：screenshot=undefined + warning + run 仍 succeeded + 产品仍 draft_saved", async (t) => {
  const db = await freshDb(t);
  const localProductId = await setupStuckProduct(db, makeStuckRun());
  // page.screenshot 抛错 → 触发 finalizeRunWithScreenshot 内部 catch
  const fakePage = { screenshot: async () => { throw new Error("Cannot take screenshot with 0 width"); } };
  const browserMock = makeBrowserMock({ page: fakePage });
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);
  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
  assert.equal(recovered, true);
  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "succeeded", "截图再次失败必须仍 succeeded");
  assert.equal(after.automation!.currentPhase, undefined);
  assert.equal(after.automation!.screenshot, undefined, "截图路径必须置 undefined");
  assert.equal(after.status, "draft_saved");
  const messages = after.automation!.logs.map((l) => l.message);
  assert.ok(messages.some((m) => /收尾截图失败/.test(m)), "截图再次失败必须写一条 warning 日志");
});

test("L5 拿不到 page：仍 succeeded + draft_saved，不抛错", async (t) => {
  const db = await freshDb(t);
  const localProductId = await setupStuckProduct(db, makeStuckRun());
  const failingBrowser = {
    setVisible: () => undefined,
    view: { getBounds: () => ({ width: 0, height: 0 }) },
    setBounds: () => undefined,
    async page() { throw new Error("未找到嵌入式 VBK 页面"); },
  } as unknown as VbkBrowser;
  const ctx = makeContext(db, failingBrowser, () => undefined, () => undefined);
  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
  assert.equal(recovered, true);
  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "succeeded");
  assert.equal(after.automation!.screenshot, undefined);
  assert.equal(after.status, "draft_saved");
  const messages = after.automation!.logs.map((l) => l.message);
  assert.ok(messages.some((m) => /恢复路径无法获取页面/.test(m)));
});

// ───────────────────────── L2/L3: 业务真失败 + needs_user → 不恢复 ─────────────────────────

test("L2 业务真失败：任一 phase !== completed → 不恢复，原状态完全保留", async (t) => {
  const db = await freshDb(t);
  const run: AutomationRun = {
    ...makeStuckRun(),
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "completed" },
      { phase: "itinerary", status: "failed" },
      { phase: "package", status: "pending" },
      { phase: "preflight", status: "pending" },
    ],
    recovery: { phases: { itinerary: { phase: "itinerary", state: "needs_user", attempts: [] } } },
  };
  const localProductId = await setupStuckProduct(db, run);
  const browserMock = makeBrowserMock();
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);

  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
  assert.equal(recovered, false, "业务真失败绝不进入恢复路径");
  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "failed", "原 status 必须保留");
  assert.equal(after.status, "blocked", "原产品状态必须保留");
  assert.equal(browserMock.pageCalls, 0);
  assert.equal(browserMock.setVisibleCalls.length, 0);
  assert.equal(browserMock.ensureBoundsCalls, 0);
});

test("L3 needs_user 还在但所有 phase 都 completed：不恢复（绝不能吞业务失败）", async (t) => {
  const db = await freshDb(t);
  const run: AutomationRun = {
    ...makeStuckRun(),
    recovery: { phases: { basic: { phase: "basic", state: "needs_user", attempts: [] } } },
  };
  const localProductId = await setupStuckProduct(db, run);
  const browserMock = makeBrowserMock();
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);

  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
  assert.equal(recovered, false, "needs_user 还在 → 绝不恢复");
  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "failed");
  assert.equal(after.status, "blocked");
  assert.equal(browserMock.pageCalls, 0);
});

// ───────────────────────── L4: 多类不命中 ─────────────────────────

test("L4 最后 error log 不是截图错误（普通业务错误）：不恢复", async (t) => {
  const db = await freshDb(t);
  const run: AutomationRun = {
    ...makeStuckRun(),
    logs: [
      { at: "2026-08-12T01:00:00.000Z", message: "正在保存：basic", level: "info" },
      { at: "2026-08-12T01:01:00.000Z", message: "VBK 端返回 500", level: "error" },
    ],
  };
  const localProductId = await setupStuckProduct(db, run);
  const browserMock = makeBrowserMock();
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);
  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
  assert.equal(recovered, false);
  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "failed");
  assert.equal(after.status, "blocked");
});

test("L4 run 状态不是 failed：不恢复（running / succeeded / cancelled 都跳过）", async (t) => {
  const db = await freshDb(t);
  for (const status of ["running", "succeeded", "cancelled"] as const) {
    const localProductId = await setupStuckProduct(db, { ...makeStuckRun(), status });
    const browserMock = makeBrowserMock();
    const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);
    const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makeLock());
    assert.equal(recovered, false, `status=${status} 时绝不恢复`);
  }
});

test("L4 productId 缺失：不恢复（远程草稿未创建，没法切 draft_saved）", async (t) => {
  const db = await freshDb(t);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, product.product, "blocked");
  db.saveAutomation(product.id, makeStuckRun());
  const browserMock = makeBrowserMock();
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);
  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, product.id, makeLock());
  assert.equal(recovered, false);
});

// ───────────────────────── L6: 互斥 ─────────────────────────

/** 互斥体工厂：模拟 DraftAutomation 真实持有集合；用于断言"未命中/异常路径也释放锁"。 */
function makeRealLock(localProductId: string): { acquire: () => boolean; release: () => void; held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    acquire: () => (held.has(localProductId) ? false : (held.add(localProductId), true)),
    release: () => { held.delete(localProductId); },
  };
}

/** 简化锁：用于只关心"未命中返回 false"的判定，持有集合不参与断言。 */
function makeLock() {
  return { acquire: () => true, release: () => undefined, held: new Set<string>() };
}

/** 永远 acquire 失败的锁：模拟"另一个 runner 正在跑"。 */
function makePreHeldLock() {
  return { acquire: () => false, release: () => undefined, held: new Set<string>() };
}

test("L6 锁被预占时：acquire 失败 → 立即返回 false，不动 run/产品状态", async (t) => {
  const db = await freshDb(t);
  const localProductId = await setupStuckProduct(db, makeStuckRun());
  const browserMock = makeBrowserMock();
  const ctx = makeContext(db, browserMock.browser, browserMock.ensureBrowserHasBounds, () => undefined);
  const recovered = await recoverLegacyScreenshotFalseFailure(ctx, localProductId, makePreHeldLock());
  assert.equal(recovered, false, "锁被占 → 直接返回 false，不进入恢复路径");
  const after = db.getProduct(localProductId)!;
  assert.equal(after.automation!.status, "failed", "锁被占期间不修改 run.status");
  assert.equal(after.status, "blocked", "锁被占期间不修改产品状态");
  assert.equal(browserMock.pageCalls, 0);
  assert.equal(browserMock.setVisibleCalls.length, 0);
});

test("L7 未命中/IO 异常时锁也必须被释放，retry 不会自锁", async (t) => {
  // 子断言 A：无 productId → 不命中 → 锁立刻释放；可再次进入判定
  const dbA = await freshDb(t);
  const productA = dbA.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  dbA.updateProduct(productA.id, productA.product, "blocked");
  dbA.saveAutomation(productA.id, makeStuckRun());
  const lockA = makeRealLock(productA.id);
  const ctxA = makeContext(dbA, makeBrowserMock().browser, () => undefined, () => undefined);
  assert.equal(await recoverLegacyScreenshotFalseFailure(ctxA, productA.id, lockA), false, "无 productId 不命中");
  assert.equal(lockA.held.has(productA.id), false, "未命中必须立刻 release 锁");
  assert.equal(await recoverLegacyScreenshotFalseFailure(ctxA, productA.id, lockA), false, "第二次仍可正常进入判定");

  // 子断言 B：page() 抛错 → 走 finally 释放；retry 不自锁
  const dbB = await freshDb(t);
  const localProductIdB = await setupStuckProduct(dbB, makeStuckRun());
  const lockB = makeRealLock(localProductIdB);
  const failingBrowser = {
    setVisible: () => undefined,
    view: { getBounds: () => ({ width: 0, height: 0 }) },
    setBounds: () => undefined,
    async page() { throw new Error("network down"); },
  } as unknown as VbkBrowser;
  const ctxB = makeContext(dbB, failingBrowser, () => undefined, () => undefined);
  assert.equal(await recoverLegacyScreenshotFalseFailure(ctxB, localProductIdB, lockB), true, "page 抛错仍 succeeded");
  assert.equal(lockB.held.has(localProductIdB), false, "finally 必须释放锁，retry 才不会自锁");
});

// ───────────────────────── isLegacyScreenshotFalseFailure 单测 ─────────────────────────

test("isLegacyScreenshotFalseFailure: 命中 page.screenshot 错误 / Page.captureScreenshot 错误", () => {
  for (const message of [
    "page.screenshot: page closed",
    "Protocol error (Page.captureScreenshot): Page closed",
    "Cannot take screenshot with 0 width",
  ]) {
    assert.equal(
      isLegacyScreenshotFalseFailure({ ...makeStuckRun(), logs: [{ at: "2026-08-12T01:00:00.000Z", message, level: "error" }] }),
      true,
      `${message} 必须命中`,
    );
  }
});

test("isLegacyScreenshotFalseFailure: 业务错误 / warning level / undefined / null 都不命中", () => {
  // 业务错误
  assert.equal(
    isLegacyScreenshotFalseFailure({
      ...makeStuckRun(),
      logs: [{ at: "2026-08-12T01:00:00.000Z", message: "VBK 端返回 500", level: "error" }],
    }),
    false,
  );
  // warning level 不算 error
  assert.equal(
    isLegacyScreenshotFalseFailure({
      ...makeStuckRun(),
      logs: [{ at: "2026-08-12T01:00:00.000Z", message: "page.screenshot with 0 width", level: "warning" }],
    }),
    false,
  );
  // undefined / null 安全
  assert.equal(isLegacyScreenshotFalseFailure(undefined), false);
  assert.equal(isLegacyScreenshotFalseFailure(null), false);
});