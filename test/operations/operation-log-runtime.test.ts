import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { buildOperationLogCsv } from "../../src/main/operations/operation-log-csv.js";
import { captureRuntimeLog, loadOperationLog, setOperationLogDb } from "../../src/main/operations/operation-log-store.js";

test("运行日志持久化、按级别来源查询，并在 CSV 导出前再次脱敏", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vbk-log-test-"));
  try {
    const db = new VbkDatabase(directory);
    setOperationLogDb(db);
    captureRuntimeLog({
      level: "error", source: "main", occurredAt: "2026-08-22T02:00:00.000Z",
      module: "planning", message: "请求失败 apiKey=top-secret", context: { password: "never-export", attempt: 3, localProductId: "product-7", elapsedMs: 480 },
    });
    captureRuntimeLog({ level: "info", source: "renderer", occurredAt: "2026-08-22T02:00:01.000Z", message: "页面准备完成" });

    const filtered = loadOperationLog({ level: "error", source: "main" });
    assert.equal(filtered.entries.length, 1);
    assert.equal(filtered.summary.error, 1);
    assert.equal(filtered.entries[0].module, "planning");
    assert.equal(filtered.entries[0].localProductId, "product-7");
    assert.equal(filtered.entries[0].attempt, 3);
    assert.equal(filtered.entries[0].durationMs, 480);
    assert.equal(filtered.entries[0].message?.includes("top-secret"), false);
    assert.equal(JSON.stringify(filtered.entries[0].context).includes("never-export"), false);

    const csv = buildOperationLogCsv(filtered.entries);
    assert.equal(csv.startsWith("\uFEFF"), true);
    assert.match(csv, /planning/);
    assert.equal(csv.includes("top-secret"), false);
    assert.equal(csv.includes("never-export"), false);
  } finally {
    setOperationLogDb(undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
