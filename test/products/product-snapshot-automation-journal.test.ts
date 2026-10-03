import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import type { AutomationRun, ProductDetail } from "../../src/shared/contracts.js";
import { productReport } from "../../src/main/infrastructure/product-report.js";

function makeDb() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-automation-journal-"));
  return {
    db: new VbkDatabase(dataPath),
    cleanup: () => fs.rmSync(dataPath, { recursive: true, force: true }),
  };
}

function run(id: string, status: AutomationRun["status"], at?: string): AutomationRun {
  return {
    id,
    status,
    phases: [{ phase: "basic", status: status === "succeeded" ? "completed" : "failed" }],
    logs: at ? [{ at, message: status, level: status === "failed" ? "error" : "info" }] : [],
  };
}

function runWithRecoveryAttempt(id: string, status: AutomationRun["status"], at: string): AutomationRun {
  return {
    id,
    status,
    phases: [{ phase: "basic", status: status === "succeeded" ? "completed" : "failed" }],
    logs: [],
    recovery: {
      phases: {
        basic: { phase: "basic", state: "needs_user", attempts: [{ attempt: 1, error: status, at }] },
      },
    },
  };
}

function snapshot(product: ProductDetail, automation: AutomationRun): ProductDetail {
  return { ...product, updatedAt: "2030-01-01T00:00:00.000Z", automation };
}

function journalRows(db: VbkDatabase, localProductId: string) {
  const raw = db as unknown as {
    db: { prepare(sql: string): { all(...args: unknown[]): Array<{ id: string; local_product_id: string; payload_json: string }> } };
  };
  return raw.db.prepare(
    "SELECT id,local_product_id,payload_json FROM automation_runs WHERE local_product_id=? ORDER BY id",
  ).all(localProductId).map((row) => ({ ...row, run: JSON.parse(row.payload_json) as AutomationRun }));
}

test("较新的产品快照不能用旧 failed run 覆盖本地 completed journal", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, run("same-run", "succeeded", "2030-01-03T00:00:00.000Z"));

    db.importProductSnapshot(snapshot(product, run("same-run", "failed", "2030-01-02T00:00:00.000Z")));

    assert.equal(journalRows(db, product.id)[0]?.run.status, "succeeded");
  } finally { cleanup(); }
});

test("较新运行检查点去掉日志后仍能更新阶段并保留本机日志和截图", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    const localRun = { ...run("same-run", "failed", "2030-01-02T00:00:00.000Z"), screenshot: "/local.png" };
    db.saveAutomation(product.id, localRun);
    const compact = productReport(snapshot(product, run("same-run", "succeeded", "2030-01-03T00:00:00.000Z")));
    assert.deepEqual(compact.automation?.logs, []);
    assert.equal(compact.automation?.updatedAt, "2030-01-03T00:00:00.000Z");
    const imported = db.importProductSnapshot(compact);
    assert.equal(imported.automation?.status, "succeeded");
    assert.deepEqual(imported.automation?.logs, localRun.logs);
    assert.equal(imported.automation?.screenshot, "/local.png");
  } finally { cleanup(); }
});

test("同一 run 的真实较新远端 failed 日志会替换本地 journal", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, run("same-run", "succeeded", "2030-01-02T00:00:00.000Z"));

    db.importProductSnapshot(snapshot(product, run("same-run", "failed", "2030-01-03T00:00:00.000Z")));

    assert.equal(journalRows(db, product.id)[0]?.run.status, "failed");
  } finally { cleanup(); }
});

test("同一 run 的 recovery attempt 时间也能证明远端状态更新", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, run("same-run", "succeeded", "2030-01-02T00:00:00.000Z"));

    db.importProductSnapshot(snapshot(product, runWithRecoveryAttempt("same-run", "failed", "2030-01-03T00:00:00.000Z")));

    assert.equal(journalRows(db, product.id)[0]?.run.status, "failed");
    assert.equal(journalRows(db, product.id)[0]?.run.logs[0]?.message, "succeeded", "compact checkpoint must preserve local logs");
  } finally { cleanup(); }
});

test("远端未列出的本地 run 在导入产品快照后仍保留", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, run("local-only", "succeeded", "2030-01-03T00:00:00.000Z"));

    db.importProductSnapshot(snapshot(product, run("remote-only", "failed", "2030-01-02T00:00:00.000Z")));

    assert.deepEqual(journalRows(db, product.id).map((row) => [row.id, row.run.status]), [
      ["local-only", "succeeded"],
      ["remote-only", "failed"],
    ]);
  } finally { cleanup(); }
});

test("同一 run 的无效、相等或缺失 run 时间均保留本地 journal", () => {
  const { db, cleanup } = makeDb();
  try {
    const product = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    db.saveAutomation(product.id, run("same-run", "succeeded", "2030-01-03T00:00:00.000Z"));

    db.importProductSnapshot(snapshot(product, run("same-run", "failed", "not-a-date")));
    db.importProductSnapshot(snapshot(product, run("same-run", "failed", "2030-01-03T00:00:00.000Z")));
    db.importProductSnapshot(snapshot(product, run("same-run", "failed")));

    assert.equal(journalRows(db, product.id)[0]?.run.status, "succeeded");
  } finally { cleanup(); }
});

test("跨产品同名 run id 不会被快照导入挪用", () => {
  const { db, cleanup } = makeDb();
  try {
    const first = db.createProduct({ destination: "潮州", days: 2, productForm: "privateTour" });
    const second = db.createProduct({ destination: "汕头", days: 2, productForm: "privateTour" });
    db.saveAutomation(first.id, run("shared-run", "succeeded", "2030-01-03T00:00:00.000Z"));

    db.importProductSnapshot(snapshot(second, run("shared-run", "failed", "2030-01-04T00:00:00.000Z")));

    assert.equal(journalRows(db, first.id)[0]?.run.status, "succeeded");
    assert.deepEqual(journalRows(db, second.id), []);
  } finally { cleanup(); }
});
