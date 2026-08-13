import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import type { AutomationRun, PhaseRecovery } from "../../src/shared/contracts.js";

// ───────────────────────── helpers ─────────────────────────

async function makeDb(): Promise<{ db: VbkDatabase; cleanup: () => void }> {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-test-orphan-"));
  const db = new VbkDatabase(dataPath);
  return {
    db,
    cleanup: () => {
      try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function makeRunningRun(opts: { runId?: string; phase: "basic" | "presentation"; state: "running" | "advising" | "retrying" | "needs_user" | "completed"; attempts?: PhaseRecovery["attempts"]; attemptsHistory?: PhaseRecovery["attempts"] } = { phase: "basic", state: "running" }): AutomationRun {
  const recovery: AutomationRun["recovery"] = { phases: {} };
  const rec: PhaseRecovery = {
    phase: opts.phase,
    state: opts.state,
    attempts: opts.attempts ?? [],
    ...(opts.attemptsHistory ? { attemptsHistory: opts.attemptsHistory } : {}),
  };
  recovery!.phases[opts.phase] = rec;
  return {
    id: opts.runId ?? "run-orphan-1",
    status: "running",
    phases: [{ phase: opts.phase, status: "running" }],
    logs: [],
    recovery,
  };
}

function makeCompletedRun(): AutomationRun {
  return {
    id: "run-completed",
    status: "succeeded",
    phases: [{ phase: "basic", status: "completed" }],
    logs: [],
    recovery: {
      phases: {
        basic: { phase: "basic", state: "completed", attempts: [] },
      },
    },
  };
}

// ───────────────────────── 测试 ─────────────────────────

test("recoverOrphanAutomationRuns：status=running 的 run 启动时变为 failed", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, makeRunningRun());
    db.updateProduct(product.id, product.product, "automating");

    const touched = db.recoverOrphanAutomationRuns();
    assert.deepEqual(touched, [product.id]);

    const after = db.getProduct(product.id)!;
    assert.ok(after.automation);
    assert.equal(after.automation!.status, "failed");
    // 业务状态也应该回到 blocked，让 UI 不再当作「正在录入」渲染。
    assert.equal(after.status, "blocked");
  } finally { cleanup(); }
});

test("recoverOrphanAutomationRuns：recovery.phases 里仍为 running 的项被强制改成 needs_user", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, makeRunningRun({ phase: "basic", state: "running" }));
    db.updateProduct(product.id, product.product, "automating");

    db.recoverOrphanAutomationRuns();

    const after = db.getProduct(product.id)!;
    const basic = after.automation?.recovery?.phases.basic;
    assert.ok(basic, "basic recovery record should exist");
    assert.equal(basic!.state, "needs_user");
    // 默认填一个 userInstruction（rec 没有原指令时），让 UI banner 能渲染
    assert.match(basic!.userInstruction || "", /核查|手动|重新/);
  } finally { cleanup(); }
});

test("recoverOrphanAutomationRuns：advising / retrying 也会被改成 needs_user", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, makeRunningRun({ runId: "run-advising", phase: "presentation", state: "advising" }));
    db.updateProduct(product.id, product.product, "automating");
    db.recoverOrphanAutomationRuns();

    const after = db.getProduct(product.id)!;
    const pres = after.automation?.recovery?.phases.presentation;
    assert.equal(pres?.state, "needs_user");

    // 同时再放一个 retrying 验证
    const product2 = db.createProduct({ destination: "大同", days: 2, productForm: "privateTour" });
    db.saveAutomation(product2.id, makeRunningRun({ runId: "run-retrying", phase: "basic", state: "retrying" }));
    db.updateProduct(product2.id, product2.product, "automating");
    db.recoverOrphanAutomationRuns();
    const after2 = db.getProduct(product2.id)!;
    assert.equal(after2.automation?.recovery?.phases.basic?.state, "needs_user");
  } finally { cleanup(); }
});

test("recoverOrphanAutomationRuns：history 归档保留（attempts + attemptsHistory 都不丢）", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    const attempts = [
      { attempt: 1, error: "第一轮第 1 次失败", at: "2026-08-02T00:00:01.000Z" },
      { attempt: 2, error: "第一轮第 2 次失败", at: "2026-08-02T00:00:02.000Z" },
      { attempt: 3, error: "第一轮第 3 次失败", at: "2026-08-02T00:00:03.000Z" },
    ];
    const attemptsHistory = [
      { attempt: 1, error: "更早的一次失败", at: "2026-08-01T00:00:01.000Z" },
    ];
    db.saveAutomation(product.id, makeRunningRun({ phase: "basic", state: "running", attempts, attemptsHistory }));
    db.updateProduct(product.id, product.product, "automating");

    db.recoverOrphanAutomationRuns();

    const after = db.getProduct(product.id)!;
    const rec = after.automation?.recovery?.phases.basic;
    assert.ok(rec);
    assert.equal(rec!.attempts.length, 3);
    assert.equal(rec!.attemptsHistory?.length, 1);
    assert.equal(rec!.attempts[0].error, "第一轮第 1 次失败");
    assert.equal(rec!.attemptsHistory?.[0].error, "更早的一次失败");
  } finally { cleanup(); }
});

test("recoverOrphanAutomationRuns：status=succeeded 的 run 不被改动", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, makeCompletedRun());
    db.updateProduct(product.id, product.product, "draft_saved");

    const touched = db.recoverOrphanAutomationRuns();
    assert.deepEqual(touched, []);

    const after = db.getProduct(product.id)!;
    assert.equal(after.automation?.status, "succeeded");
    assert.equal(after.status, "draft_saved");
  } finally { cleanup(); }
});

test("recoverOrphanAutomationRuns：append 一条 warning 日志，让 UI 知道为什么停了", async () => {
  const { db, cleanup } = await makeDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, makeRunningRun({ phase: "basic", state: "running" }));
    db.updateProduct(product.id, product.product, "automating");

    db.recoverOrphanAutomationRuns();

    const after = db.getProduct(product.id)!;
    const lastLog = after.automation?.logs.at(-1);
    assert.ok(lastLog);
    assert.equal(lastLog!.level, "warning");
    assert.match(lastLog!.message, /重启|停止|重新保存/);
  } finally { cleanup(); }
});