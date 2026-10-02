import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createWatchReadyGate, verifyMainModuleLink } from "../../scripts/dev-main-watch.mjs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test("陈旧入口存在时，watch 成功信号前不放行 Electron", async () => {
  const verified = deferred<void>();
  let markedReady = false;
  const gate = createWatchReadyGate({
    verify: () => verified.promise,
    markReady: async () => { markedReady = true; },
  });

  await gate("Starting compilation in watch mode...\n");
  assert.equal(markedReady, false);

  const release = gate("Found 0 errors. Watching for file changes.\n");
  await Promise.resolve();
  assert.equal(markedReady, false, "链接校验未完成时不得放行");
  verified.resolve();
  await release;
  assert.equal(markedReady, true);
});

test("编译错误输出不会放行 Electron", async () => {
  let verified = false;
  let markedReady = false;
  const gate = createWatchReadyGate({
    verify: async () => { verified = true; },
    markReady: async () => { markedReady = true; },
  });

  await gate("Found 1 error. Watching for file changes.\n");
  assert.equal(verified, false);
  assert.equal(markedReady, false);
});

test("真实 ESM 链接会拒绝缺失的命名导出", async () => {
  const fixture = path.join(process.cwd(), "test", "fixtures", "dev-main-ready", "missing-export-entry.mjs");
  await assert.rejects(verifyMainModuleLink(fixture), /does not provide an export named 'requiredExport'/);
});

test("编译产物的 integration 模块可完成真实 ESM 导出链接", async () => {
  await assert.doesNotReject(
    verifyMainModuleLink(path.join(process.cwd(), "dist-electron", "main", "agent", "integration.js")),
  );
});
