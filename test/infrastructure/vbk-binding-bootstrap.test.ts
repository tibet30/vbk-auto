import test from "node:test";
import assert from "node:assert/strict";
import { createBindingSyncScheduler } from "../../src/main/infrastructure/vbk-binding-bootstrap.js";

test("forceSync 在 in-flight status sync 之后仍会为新 user 再跑一遍", async () => {
  const calls: number[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted = false;

  const scheduler = createBindingSyncScheduler({
    syncFromRemote: async (userId) => {
      calls.push(userId);
      if (!firstStarted) {
        firstStarted = true;
        await firstGate;
      }
    },
    restoreFromCache: async () => undefined,
  });

  const statusSync = scheduler.syncAndRestore(1); // soft — first sync for user 1
  // Wait until first job is in syncFromRemote
  for (let i = 0; i < 50 && !firstStarted; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(firstStarted, true);

  const switchSync = scheduler.syncAndRestore(2, { forceSync: true });
  releaseFirst();
  await Promise.all([statusSync, switchSync]);

  assert.deepEqual(calls, [1, 2]);
  assert.equal(scheduler.getLastSyncedUserId(), 2);
});

test("非 forceSync 对同一 user 的第二次调用不重复 sync", async () => {
  const calls: number[] = [];
  const scheduler = createBindingSyncScheduler({
    syncFromRemote: async (userId) => { calls.push(userId); },
    restoreFromCache: async () => undefined,
  });
  await scheduler.syncAndRestore(9);
  await scheduler.syncAndRestore(9);
  assert.deepEqual(calls, [9]);
});

test("forceSync 对同一 user 也会再跑 sync", async () => {
  const calls: number[] = [];
  const scheduler = createBindingSyncScheduler({
    syncFromRemote: async (userId) => { calls.push(userId); },
    restoreFromCache: async () => undefined,
  });
  await scheduler.syncAndRestore(3);
  await scheduler.syncAndRestore(3, { forceSync: true });
  assert.deepEqual(calls, [3, 3]);
});
