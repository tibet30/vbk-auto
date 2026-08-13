/**
 * products.status ↔ planning_generation 同步 — 四类状态不变量测试。
 *
 * 把决策（pure）与副作用（DB 写）都隔到 src/main/planning/product-status-sync.ts 里；
 * 本文件作为「实现已就位」的 regression 网，覆盖四类不变量：
 *
 *   Category A — runPlan completed：
 *     仅当 products.status=planning 时推到 review；
 *     review / automating / draft_saved / blocked 一律不动。
 *
 *   Category B — runPlan failed / needs_user：
 *     仅当 products.status=planning 时推到 blocked；
 *     review / automating / draft_saved / blocked 一律不动，防止「自动化刚把
 *     产品标 automating 时被规划改回 blocked」。
 *
 *   Category C — preflight 失败（syncProductStatusAfterFailure）：
 *     与 Category B 同语义，触发点是 preflight + runPlan 之外的逃逸异常；
 *     planning → blocked，其他状态不动。
 *
 *   Category D — 用户显式 planning:start / planning:resume：
 *     仅当 products.status=blocked 且持久化 planning_generation.status ∈
 *     { failed, needs_user } 时恢复 planning；其他来源的 blocked
 *     （自动化孤儿恢复 / 运营手工 / 持久化为 completed / running / pending /
 *     不存在）一律不动。
 *
 * 另附四类不变量对应的纯决策函数边界用例、持久化往返与白名单 sanity。
 *
 * 不依赖 jsdom / electron / browser，纯 VbkDatabase + 决策函数断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  PLANNING_FAILURE_STATUSES,
  restoreProductToPlanningForRetry,
  shouldRestoreProductToPlanning,
  shouldSyncProductToBlocked,
  shouldSyncProductToReview,
  syncProductStatusAfterFailure,
  syncProductStatusAfterRunPlan,
} from "../../src/main/planning/product-status-sync.js";
import type { PlanningGenerationState } from "../../src/shared/contracts-planning.js";

// ──────────────────────────────────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────────────────────────────────

function makeDb(): { db: VbkDatabase; cleanup: () => void } {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-proj-status-sync-"));
  const db = new VbkDatabase(dataPath);
  return {
    db,
    cleanup: () => { try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

function makeProductByStatus(
  db: VbkDatabase,
  status: "planning" | "review" | "automating" | "draft_saved" | "blocked",
): string {
  // createProduct 默认落 status="planning"；如需其他状态，用 updateProduct 调整。
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  if (status !== "planning") db.updateProduct(product.id, product.product, status);
  return product.id;
}

const NON_PLANNING_STATUSES = ["review", "automating", "draft_saved", "blocked"] as const;

// ──────────────────────────────────────────────────────────────────────────
// Category A — runPlan completed → 仅当 products.status=planning 推到 review
// ──────────────────────────────────────────────────────────────────────────

test("Category A · products.status=planning + runPlan=completed → 推到 review", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "planning");
    const applied = syncProductStatusAfterRunPlan(db, id, "completed");
    assert.equal(applied.applied, true);
    assert.equal(db.getProduct(id)!.status, "review");
  } finally { cleanup(); }
});

test("Category A · products.status=automating + runPlan=completed → 不动（completed 不取代 automating）", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "automating");
    const applied = syncProductStatusAfterRunPlan(db, id, "completed");
    assert.equal(applied.applied, false);
    assert.equal(db.getProduct(id)!.status, "automating");
  } finally { cleanup(); }
});

test("Category A · products.status∈{review,draft_saved} + runPlan=completed → 不动", () => {
  for (const status of ["review", "draft_saved"] as const) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProductByStatus(db, status);
      const applied = syncProductStatusAfterRunPlan(db, id, "completed");
      assert.equal(applied.applied, false, `${status} 不应被 completed 覆盖为 review`);
      assert.equal(db.getProduct(id)!.status, status);
    } finally { cleanup(); }
  }
});

test("Category A · products.status=blocked + runPlan=completed → 不动（completed 不替阻塞的 blocked 解锁）", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "blocked");
    const applied = syncProductStatusAfterRunPlan(db, id, "completed");
    assert.equal(applied.applied, false);
    assert.equal(db.getProduct(id)!.status, "blocked");
  } finally { cleanup(); }
});

// ──────────────────────────────────────────────────────────────────────────
// Category B — runPlan failed / needs_user → 仅当 products.status=planning 推到 blocked
// ──────────────────────────────────────────────────────────────────────────

test("Category B · products.status=planning + runPlan=failed → 推到 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "planning");
    const applied = syncProductStatusAfterRunPlan(db, id, "failed");
    assert.equal(applied.applied, true);
    assert.equal(db.getProduct(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category B · products.status=planning + runPlan=needs_user → 推到 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "planning");
    const applied = syncProductStatusAfterRunPlan(db, id, "needs_user");
    assert.equal(applied.applied, true);
    assert.equal(db.getProduct(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category B · products.status=automating + runPlan=failed → 不动（避免规划改回正在自动化的 blocked）", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "automating");
    const applied = syncProductStatusAfterRunPlan(db, id, "failed");
    assert.equal(applied.applied, false);
    assert.equal(db.getProduct(id)!.status, "automating");
  } finally { cleanup(); }
});

test("Category B · products.status∈{review,draft_saved,blocked} + runPlan∈{failed,needs_user} → 不动", () => {
  for (const productStatus of ["review", "draft_saved", "blocked"] as const) {
    for (const runStatus of ["failed", "needs_user"] as const) {
      const { db, cleanup } = makeDb();
      try {
        const id = makeProductByStatus(db, productStatus);
        const applied = syncProductStatusAfterRunPlan(db, id, runStatus);
        assert.equal(applied.applied, false, `${productStatus}+${runStatus} 不应被覆盖`);
        assert.equal(db.getProduct(id)!.status, productStatus);
      } finally { cleanup(); }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Category C — preflight 失败（syncProductStatusAfterFailure）→ 等同 Category B
// ──────────────────────────────────────────────────────────────────────────

test("Category C · products.status=planning + preflight 失败 → 推到 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "planning");
    const applied = syncProductStatusAfterFailure(db, id);
    assert.equal(applied.applied, true);
    assert.equal(db.getProduct(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category C · products.status∈{review,automating,draft_saved,blocked} + preflight 失败 → 不动", () => {
  for (const status of NON_PLANNING_STATUSES) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProductByStatus(db, status);
      const applied = syncProductStatusAfterFailure(db, id);
      assert.equal(applied.applied, false, `${status} 不应被 preflight 失败覆盖`);
      assert.equal(db.getProduct(id)!.status, status);
    } finally { cleanup(); }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Category D — 用户显式 planning:start / planning:resume → 仅当 products.status=blocked 且
// planning_generation.status ∈ {failed,needs_user} 时恢复 planning
// ──────────────────────────────────────────────────────────────────────────

test("Category D · products.status=blocked + planning_gen=failed → 恢复 planning", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "blocked");
    const result = restoreProductToPlanningForRetry(db, id, "failed");
    assert.deepEqual(result, { restored: true, newStatus: "planning" });
    assert.equal(db.getProduct(id)!.status, "planning");
  } finally { cleanup(); }
});

test("Category D · products.status=blocked + planning_gen=needs_user → 恢复 planning", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "blocked");
    const result = restoreProductToPlanningForRetry(db, id, "needs_user");
    assert.deepEqual(result, { restored: true, newStatus: "planning" });
    assert.equal(db.getProduct(id)!.status, "planning");
  } finally { cleanup(); }
});

test("Category D · products.status=blocked + planning_gen∈{completed,running,pending} → 保持 blocked", () => {
  for (const planningStatus of ["completed", "running", "pending"] as const) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProductByStatus(db, "blocked");
      const result = restoreProductToPlanningForRetry(db, id, planningStatus);
      assert.equal(result.restored, false, `planning_gen=${planningStatus} 不应被误恢复为 planning`);
      assert.equal(result.newStatus, "blocked");
      assert.equal(db.getProduct(id)!.status, "blocked");
    } finally { cleanup(); }
  }
});

test("Category D · products.status=blocked + planning_gen 不存在（未持久化） → 保持 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "blocked");
    // planning_gen 缺失：main.ts 在调 restore 之前已经 loadPlanningState；undefined 表示未持久化。
    const result = restoreProductToPlanningForRetry(db, id, undefined);
    assert.equal(result.restored, false);
    assert.equal(result.newStatus, "blocked");
    assert.equal(db.getProduct(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category D · products.status∈{planning,review,automating,draft_saved} + planning_gen=failed → 保持原状", () => {
  for (const status of ["planning", "review", "automating", "draft_saved"] as const) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProductByStatus(db, status);
      const result = restoreProductToPlanningForRetry(db, id, "failed");
      assert.equal(result.restored, false, `products.status=${status} 不应被恢复`);
      assert.equal(result.newStatus, status);
      assert.equal(db.getProduct(id)!.status, status);
    } finally { cleanup(); }
  }
});

test("Category D · 产品不存在 → restored=false, newStatus='unknown'", () => {
  const { db, cleanup } = makeDb();
  try {
    const result = restoreProductToPlanningForRetry(db, "does-not-exist", "failed");
    assert.deepEqual(result, { restored: false, newStatus: "unknown" });
  } finally { cleanup(); }
});

test("Category D (DB 往返) · savePlanningState(status=failed) → loadPlanningState 看到的就是 failed → restore 触发", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProductByStatus(db, "blocked");
    const state: PlanningGenerationState = {
      localProductId: id,
      currentStage: "validation",
      completedStages: [],
      stages: [],
      status: "failed",
      resumeAt: "2026-01-01T00:00:00.000Z",
    };
    db.savePlanningState(state);
    const persisted = db.loadPlanningState(id);
    assert.ok(persisted, "loadPlanningState 必须返回刚保存的状态");
    assert.equal(persisted!.status, "failed");
    // 模拟 main.ts 的写法：拿到 status 后交给恢复函数。
    const result = restoreProductToPlanningForRetry(db, id, persisted!.status);
    assert.equal(result.restored, true);
    assert.equal(db.getProduct(id)!.status, "planning");
  } finally { cleanup(); }
});

// ──────────────────────────────────────────────────────────────────────────
// 决策函数 truth-table（覆盖四个 Category 的纯函数层）
// ──────────────────────────────────────────────────────────────────────────

test("shouldSyncProductToBlocked · 仅 failed/needs_user + products.status=planning 才 apply", () => {
  for (const runStatus of ["completed", "needs_user", "failed"] as const) {
    for (const productStatus of [undefined, "planning", "automating", "blocked", "review"] as const) {
      const decision = shouldSyncProductToBlocked({ runStatus, productStatus });
      const expectApply = (runStatus === "failed" || runStatus === "needs_user") && productStatus === "planning";
      assert.equal(decision.apply, expectApply, `runStatus=${runStatus} productStatus=${productStatus ?? "undefined"}`);
      assert.equal(decision.newStatus, "blocked");
    }
  }
});

test("shouldSyncProductToReview · 仅 products.status=planning 才 apply", () => {
  for (const productStatus of [undefined, "planning", "automating", "blocked", "review"] as const) {
    const decision = shouldSyncProductToReview({ productStatus });
    const expectApply = productStatus === "planning";
    assert.equal(decision.apply, expectApply, `productStatus=${productStatus ?? "undefined"}`);
    assert.equal(decision.newStatus, "review");
  }
});

test("shouldRestoreProductToPlanning · 仅 products.status=blocked + 持久化 failed/needs_user 才 apply", () => {
  for (const productStatus of [undefined, "planning", "blocked", "automating", "review"] as const) {
    for (const planningGen of [undefined, "failed", "needs_user", "completed", "running", "pending"] as const) {
      const decision = shouldRestoreProductToPlanning({ productStatus, planningGenerationStatus: planningGen });
      const expectApply = productStatus === "blocked" && (planningGen === "failed" || planningGen === "needs_user");
      assert.equal(decision.apply, expectApply, `productStatus=${productStatus ?? "undefined"} planningGen=${planningGen ?? "undefined"}`);
      assert.equal(decision.newStatus, "planning");
    }
  }
});

test("PLANNING_FAILURE_STATUSES 永远 = {failed, needs_user}", () => {
  assert.ok(PLANNING_FAILURE_STATUSES.has("failed"));
  assert.ok(PLANNING_FAILURE_STATUSES.has("needs_user"));
  assert.equal(PLANNING_FAILURE_STATUSES.has("completed"), false);
  assert.equal(PLANNING_FAILURE_STATUSES.has("running"), false);
  assert.equal(PLANNING_FAILURE_STATUSES.has("pending"), false);
});
