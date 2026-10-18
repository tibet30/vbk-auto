/**
 * CheckpointStore 落盘权限：
 *   - ARTIFACTS_DIR 下的断点 JSON 在 npm run dev 与生产模式都会被写；
 *   - 断点对象中 completed / failures / lastError 可能含 URL token / 调试
 *     key（同机其它用户可读会泄露）；
 *   - 因此 fs.writeFile 必须 mode 0o600。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "../../src/main/automation/workflow.js";

test("CheckpointStore.save 写入 0o600 限本机用户读", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vbk-cp-perm-"));
  try {
    const store = new CheckpointStore("p1", dir);
    await store.save({
      productId: "p1",
      completed: { basic: "done" },
      failures: [],
      lastError: "fetch failed: https://updater.test/feed?token=secret-abc123",
    });
    const file = path.join(dir, "checkpoints", "product-p1.json");
    const stat = statSync(file);
    assert.equal((stat.mode & 0o777).toString(8), "600", "checkpoint 文件必须 0o600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
