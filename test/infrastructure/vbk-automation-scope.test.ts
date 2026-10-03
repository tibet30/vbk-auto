import test from "node:test";
import assert from "node:assert/strict";
import { VbkAutomationSessions } from "../../src/main/infrastructure/vbk-automation-scope.js";
import type { AutomationSession } from "../../src/main/infrastructure/vbk-automation-session.js";

function worker(id: string, closed: string[]) {
  return { page: { url: () => id }, pin: { allowedProductIds: [id], allowCreateSetup: false },
    close: async () => { closed.push(id); } } as AutomationSession;
}

test("交错的产品执行保持各自 page 与导航 pin，错误和成功都回收页面", async () => {
  const sessions = new VbkAutomationSessions(); const closed: string[] = [];
  const a = worker("a", closed), b = worker("b", closed);
  let release!: () => void; let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const first = sessions.run(async () => a, async () => {
    assert.equal(sessions.current(), a); start();
    await new Promise<void>(resolve => { release = resolve; });
    assert.equal(sessions.current(), a);
    assert.deepEqual(sessions.current()?.pin?.allowedProductIds, ["a"]);
    throw new Error("a failed");
  });
  const failure = assert.rejects(first, /a failed/);
  await started;
  await sessions.run(async () => b, async () => {
    assert.equal(sessions.current(), b);
    assert.equal(sessions.ownsPage(a.page), true);
    sessions.current()!.pin!.allowedProductIds.push("b-child");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sessions.current(), b);
  });
  assert.equal(sessions.current(), undefined);
  assert.equal(sessions.ownsPage(b.page), false);
  release(); await failure;
  assert.deepEqual(closed, ["b", "a"]);
  assert.equal(sessions.ownsPage(a.page), false);
});
