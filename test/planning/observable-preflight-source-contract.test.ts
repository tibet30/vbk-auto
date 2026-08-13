/**
 * 锁住 main.ts 的可观测日志与 catch 兜底：用户报告「控制台看不到任何
 * 日志」时必须能在主进程 console 中 grep 到 [planning] 行；runPlan 抛错
 * 必须经过 handlePreflightFailure（已经带 console.warn）；IPC resume
 * load / restore 抛错也必须有 catch。
 *
 * 不依赖 jsdom / electron / better-sqlite3，只读 main.ts 源码做白盒断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** 提取 ipcMain.handle("key", (event, ...) => { ... }) 函数体（含闭合 `});`）。 */
function extractHandlerBody(source: string, keyword: string): string {
  const start = source.indexOf(keyword);
  if (start < 0) throw new Error(`keyword not found: ${keyword}`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error("opening brace not found");
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) throw new Error("unbalanced braces");
  return source.slice(start, i + 2);
}

/** 提取 `function name(...) {` 函数体（含外层大括号闭合）。 */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error("opening brace not found");
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) throw new Error("unbalanced braces");
  return source.slice(start, i);
}

const mainSrc = read("src/main/ipc/planning-ipc.ts");

test("handlePreflightFailure 必须有 [planning] 前缀的可观测 warn 日志", () => {
  const body = extractFunctionBody(mainSrc, "function handlePreflightFailure(");
  // logWarn / console.warn 都会被认作可观测 warn 出口（logWarn 走 console.warn 底层）。
  assert.match(body, /(console\.warn|logWarn)\(\s*[`'"[']?\[planning\]/,
    "handlePreflightFailure 必须输出 [planning] 前缀的可观测 warn 日志，避免「继续规划还是报错但日志全无」");
});

test("planning:resume handler 必须把 loadPlanningState 包在 try/catch，失败走 handlePreflightFailure", () => {
  const body = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:resume"');
  assert.match(body, /loadPlanningState\([\s\S]*?\}\s*catch\s*\(/,
    "planning:resume 必须把 loadPlanningState 包在 try/catch 内，失败时不再抛 raw Error 静默丢失");
  assert.match(body, /(console\.warn|logWarn)\([^)]*load_failed/,
    "planning:resume 在 load 失败时必须打 [planning] ipc.resume load_failed");
  assert.match(body, /handlePreflightFailure\(/,
    "planning:resume 在 load/restore 失败时必须走 handlePreflightFailure 而非 throw raw error");
});

test("planning:resume handler 必须把 restoreProductToPlanningForRetry 包在 try/catch", () => {
  const body = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:resume"');
  // 期望：try { restoreProductToPlanningForRetry(...) } catch (error) { ... handlePreflightFailure ... }
  assert.match(body, /try\s*\{[\s\S]*?restoreProductToPlanningForRetry\(/,
    "planning:resume 必须把 restoreProductToPlanningForRetry 包在 try 内，restore 抛错不应让 IPC 直接抛 raw error");
  assert.match(body, /(console\.warn|logWarn)\([^)]*restore_failed/,
    "planning:resume 在 restore 失败时必须打 [planning] ipc.resume restore_failed");
});

test("plan-orchestrator 的 resume 起点必须有显式「跳过已完成阶段」日志", () => {
  const src = read("src/main/planning/plan-orchestrator.ts");
  // 源文件里 logRunStart(...) 是模板字符串，含 ${skippedFromCurrent}，regex
  // 匹配不到模板插值；只断言「续跑跳过」前缀 + 「个已完成阶段」后缀同时存在。
  assert.ok(src.includes("续跑跳过"), "plan-orchestrator 必须有「续跑跳过」日志关键字");
  assert.ok(src.includes("个已完成阶段"), "plan-orchestrator 必须有「个已完成阶段」日志关键字");
  assert.ok(/logRunStart\([\s\S]*?续跑跳过/.test(src), "续跑跳过日志必须经过 logRunStart 输出，主进程能 grep");
});
