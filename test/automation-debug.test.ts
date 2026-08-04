import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * debug helper 的单测：覆盖生产/开发两条路径，断点记录、恢复、列表等。
 * 不依赖 Playwright。
 */

type DebugModule = typeof import("../src/main/automation/debug.js");

async function loadDebug(env: Record<string, string | undefined>): Promise<DebugModule> {
  // 隔离环境：先清掉跨用例残留
  for (const key of ["VBK_DEBUG", "VBK_DEBUG_BREAKPOINTS"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  // 用 cache-bust 强制重载
  const url = new URL("../src/main/automation/debug.ts", import.meta.url);
  url.searchParams.set("v", String(Date.now()) + Math.random());
  return (await import(url.href)) as DebugModule;
}

test("production：未设 VBK_DEBUG 时断点立即返回、不阻塞", async () => {
  const { breakpoint, resetBreakpoints, getHitBreakpoints } = await loadDebug({});
  resetBreakpoints();
  const start = Date.now();
  await breakpoint("any-name", { foo: 1 });
  assert.ok(Date.now() - start < 50, "断点应该立即返回");
  // hitBreakpoints 仍然记录命中点（用于事后审计），但 production 不暂停
  assert.deepEqual(getHitBreakpoints(), ["any-name"]);
});

test("debug：断点列表从 env VBK_DEBUG_BREAKPOINTS 解析", async () => {
  const { listBreakpoints, resetBreakpoints } = await loadDebug({
    VBK_DEBUG: "1",
    VBK_DEBUG_BREAKPOINTS: "beforeFillRecommendationReasons,afterSaveThenAdvance",
  });
  resetBreakpoints();
  assert.deepEqual(listBreakpoints(), [
    "beforeFillRecommendationReasons",
    "afterSaveThenAdvance",
  ]);
});

test("resetBreakpoints 清空 hit / pending 状态", async () => {
  const { breakpoint, resetBreakpoints, getHitBreakpoints } = await loadDebug({});
  resetBreakpoints();
  await breakpoint("x");
  await breakpoint("y");
  assert.deepEqual(getHitBreakpoints(), ["x", "y"]);
  resetBreakpoints();
  assert.deepEqual(getHitBreakpoints(), []);
});

test("resume('stop') 设置 stopped=true；后续 resume('continue') 重置", async () => {
  const { resume, isStopRequested, resetBreakpoints } = await loadDebug({});
  resetBreakpoints();
  assert.equal(isStopRequested(), false);
  assert.deepEqual(resume("stop"), { stopped: true });
  assert.equal(isStopRequested(), true);
  assert.deepEqual(resume("continue"), { stopped: false });
  assert.equal(isStopRequested(), false);
});