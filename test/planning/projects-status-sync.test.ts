/**
 * projects.status ↔ planning_generation 同步 — 四类状态不变量测试。
 *
 * 把决策（pure）与副作用（DB 写）都隔到 src/main/planning/project-status-sync.ts 里；
 * 本文件作为「实现已就位」的 regression 网，覆盖四类不变量：
 *
 *   Category A — runPlan completed：
 *     仅当 projects.status=planning 时推到 review；
 *     review / automating / draft_saved / blocked 一律不动。
 *
 *   Category B — runPlan failed / needs_user：
 *     仅当 projects.status=planning 时推到 blocked；
 *     review / automating / draft_saved / blocked 一律不动，防止「自动化刚把
 *     项目标 automating 时被规划改回 blocked」。
 *
 *   Category C — preflight 失败（syncProjectStatusAfterFailure）：
 *     与 Category B 同语义，触发点是 preflight + runPlan 之外的逃逸异常；
 *     planning → blocked，其他状态不动。
 *
 *   Category D — 用户显式 planning:start / planning:resume：
 *     仅当 projects.status=blocked 且持久化 planning_generation.status ∈
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
  restoreProjectToPlanningForRetry,
  shouldRestoreProjectToPlanning,
  shouldSyncProjectToBlocked,
  shouldSyncProjectToReview,
  syncProjectStatusAfterFailure,
  syncProjectStatusAfterRunPlan,
} from "../../src/main/planning/project-status-sync.js";
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

function makeProjectByStatus(
  db: VbkDatabase,
  status: "planning" | "review" | "automating" | "draft_saved" | "blocked",
): string {
  // createProject 默认落 status="planning"；如需其他状态，用 updateProduct 调整。
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  if (status !== "planning") db.updateProduct(project.id, project.product, status);
  return project.id;
}

const NON_PLANNING_STATUSES = ["review", "automating", "draft_saved", "blocked"] as const;

// ──────────────────────────────────────────────────────────────────────────
// Category A — runPlan completed → 仅当 projects.status=planning 推到 review
// ──────────────────────────────────────────────────────────────────────────

test("Category A · projects.status=planning + runPlan=completed → 推到 review", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "planning");
    const applied = syncProjectStatusAfterRunPlan(db, id, "completed");
    assert.equal(applied.applied, true);
    assert.equal(db.getProject(id)!.status, "review");
  } finally { cleanup(); }
});

test("Category A · projects.status=automating + runPlan=completed → 不动（completed 不取代 automating）", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "automating");
    const applied = syncProjectStatusAfterRunPlan(db, id, "completed");
    assert.equal(applied.applied, false);
    assert.equal(db.getProject(id)!.status, "automating");
  } finally { cleanup(); }
});

test("Category A · projects.status∈{review,draft_saved} + runPlan=completed → 不动", () => {
  for (const status of ["review", "draft_saved"] as const) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProjectByStatus(db, status);
      const applied = syncProjectStatusAfterRunPlan(db, id, "completed");
      assert.equal(applied.applied, false, `${status} 不应被 completed 覆盖为 review`);
      assert.equal(db.getProject(id)!.status, status);
    } finally { cleanup(); }
  }
});

test("Category A · projects.status=blocked + runPlan=completed → 不动（completed 不替阻塞的 blocked 解锁）", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "blocked");
    const applied = syncProjectStatusAfterRunPlan(db, id, "completed");
    assert.equal(applied.applied, false);
    assert.equal(db.getProject(id)!.status, "blocked");
  } finally { cleanup(); }
});

// ──────────────────────────────────────────────────────────────────────────
// Category B — runPlan failed / needs_user → 仅当 projects.status=planning 推到 blocked
// ──────────────────────────────────────────────────────────────────────────

test("Category B · projects.status=planning + runPlan=failed → 推到 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "planning");
    const applied = syncProjectStatusAfterRunPlan(db, id, "failed");
    assert.equal(applied.applied, true);
    assert.equal(db.getProject(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category B · projects.status=planning + runPlan=needs_user → 推到 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "planning");
    const applied = syncProjectStatusAfterRunPlan(db, id, "needs_user");
    assert.equal(applied.applied, true);
    assert.equal(db.getProject(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category B · projects.status=automating + runPlan=failed → 不动（避免规划改回正在自动化的 blocked）", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "automating");
    const applied = syncProjectStatusAfterRunPlan(db, id, "failed");
    assert.equal(applied.applied, false);
    assert.equal(db.getProject(id)!.status, "automating");
  } finally { cleanup(); }
});

test("Category B · projects.status∈{review,draft_saved,blocked} + runPlan∈{failed,needs_user} → 不动", () => {
  for (const projectStatus of ["review", "draft_saved", "blocked"] as const) {
    for (const runStatus of ["failed", "needs_user"] as const) {
      const { db, cleanup } = makeDb();
      try {
        const id = makeProjectByStatus(db, projectStatus);
        const applied = syncProjectStatusAfterRunPlan(db, id, runStatus);
        assert.equal(applied.applied, false, `${projectStatus}+${runStatus} 不应被覆盖`);
        assert.equal(db.getProject(id)!.status, projectStatus);
      } finally { cleanup(); }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Category C — preflight 失败（syncProjectStatusAfterFailure）→ 等同 Category B
// ──────────────────────────────────────────────────────────────────────────

test("Category C · projects.status=planning + preflight 失败 → 推到 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "planning");
    const applied = syncProjectStatusAfterFailure(db, id);
    assert.equal(applied.applied, true);
    assert.equal(db.getProject(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category C · projects.status∈{review,automating,draft_saved,blocked} + preflight 失败 → 不动", () => {
  for (const status of NON_PLANNING_STATUSES) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProjectByStatus(db, status);
      const applied = syncProjectStatusAfterFailure(db, id);
      assert.equal(applied.applied, false, `${status} 不应被 preflight 失败覆盖`);
      assert.equal(db.getProject(id)!.status, status);
    } finally { cleanup(); }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Category D — 用户显式 planning:start / planning:resume → 仅当 projects.status=blocked 且
// planning_generation.status ∈ {failed,needs_user} 时恢复 planning
// ──────────────────────────────────────────────────────────────────────────

test("Category D · projects.status=blocked + planning_gen=failed → 恢复 planning", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "blocked");
    const result = restoreProjectToPlanningForRetry(db, id, "failed");
    assert.deepEqual(result, { restored: true, newStatus: "planning" });
    assert.equal(db.getProject(id)!.status, "planning");
  } finally { cleanup(); }
});

test("Category D · projects.status=blocked + planning_gen=needs_user → 恢复 planning", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "blocked");
    const result = restoreProjectToPlanningForRetry(db, id, "needs_user");
    assert.deepEqual(result, { restored: true, newStatus: "planning" });
    assert.equal(db.getProject(id)!.status, "planning");
  } finally { cleanup(); }
});

test("Category D · projects.status=blocked + planning_gen∈{completed,running,pending} → 保持 blocked", () => {
  for (const planningStatus of ["completed", "running", "pending"] as const) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProjectByStatus(db, "blocked");
      const result = restoreProjectToPlanningForRetry(db, id, planningStatus);
      assert.equal(result.restored, false, `planning_gen=${planningStatus} 不应被误恢复为 planning`);
      assert.equal(result.newStatus, "blocked");
      assert.equal(db.getProject(id)!.status, "blocked");
    } finally { cleanup(); }
  }
});

test("Category D · projects.status=blocked + planning_gen 不存在（未持久化） → 保持 blocked", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "blocked");
    // planning_gen 缺失：main.ts 在调 restore 之前已经 loadPlanningState；undefined 表示未持久化。
    const result = restoreProjectToPlanningForRetry(db, id, undefined);
    assert.equal(result.restored, false);
    assert.equal(result.newStatus, "blocked");
    assert.equal(db.getProject(id)!.status, "blocked");
  } finally { cleanup(); }
});

test("Category D · projects.status∈{planning,review,automating,draft_saved} + planning_gen=failed → 保持原状", () => {
  for (const status of ["planning", "review", "automating", "draft_saved"] as const) {
    const { db, cleanup } = makeDb();
    try {
      const id = makeProjectByStatus(db, status);
      const result = restoreProjectToPlanningForRetry(db, id, "failed");
      assert.equal(result.restored, false, `projects.status=${status} 不应被恢复`);
      assert.equal(result.newStatus, status);
      assert.equal(db.getProject(id)!.status, status);
    } finally { cleanup(); }
  }
});

test("Category D · 项目不存在 → restored=false, newStatus='unknown'", () => {
  const { db, cleanup } = makeDb();
  try {
    const result = restoreProjectToPlanningForRetry(db, "does-not-exist", "failed");
    assert.deepEqual(result, { restored: false, newStatus: "unknown" });
  } finally { cleanup(); }
});

test("Category D (DB 往返) · savePlanningState(status=failed) → loadPlanningState 看到的就是 failed → restore 触发", () => {
  const { db, cleanup } = makeDb();
  try {
    const id = makeProjectByStatus(db, "blocked");
    const state: PlanningGenerationState = {
      projectId: id,
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
    const result = restoreProjectToPlanningForRetry(db, id, persisted!.status);
    assert.equal(result.restored, true);
    assert.equal(db.getProject(id)!.status, "planning");
  } finally { cleanup(); }
});

// ──────────────────────────────────────────────────────────────────────────
// 决策函数 truth-table（覆盖四个 Category 的纯函数层）
// ──────────────────────────────────────────────────────────────────────────

test("shouldSyncProjectToBlocked · 仅 failed/needs_user + projects.status=planning 才 apply", () => {
  for (const runStatus of ["completed", "needs_user", "failed"] as const) {
    for (const projectStatus of [undefined, "planning", "automating", "blocked", "review"] as const) {
      const decision = shouldSyncProjectToBlocked({ runStatus, projectStatus });
      const expectApply = (runStatus === "failed" || runStatus === "needs_user") && projectStatus === "planning";
      assert.equal(decision.apply, expectApply, `runStatus=${runStatus} projectStatus=${projectStatus ?? "undefined"}`);
      assert.equal(decision.newStatus, "blocked");
    }
  }
});

test("shouldSyncProjectToReview · 仅 projects.status=planning 才 apply", () => {
  for (const projectStatus of [undefined, "planning", "automating", "blocked", "review"] as const) {
    const decision = shouldSyncProjectToReview({ projectStatus });
    const expectApply = projectStatus === "planning";
    assert.equal(decision.apply, expectApply, `projectStatus=${projectStatus ?? "undefined"}`);
    assert.equal(decision.newStatus, "review");
  }
});

test("shouldRestoreProjectToPlanning · 仅 projects.status=blocked + 持久化 failed/needs_user 才 apply", () => {
  for (const projectStatus of [undefined, "planning", "blocked", "automating", "review"] as const) {
    for (const planningGen of [undefined, "failed", "needs_user", "completed", "running", "pending"] as const) {
      const decision = shouldRestoreProjectToPlanning({ projectStatus, planningGenerationStatus: planningGen });
      const expectApply = projectStatus === "blocked" && (planningGen === "failed" || planningGen === "needs_user");
      assert.equal(decision.apply, expectApply, `projectStatus=${projectStatus ?? "undefined"} planningGen=${planningGen ?? "undefined"}`);
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
