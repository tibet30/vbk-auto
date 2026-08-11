/**
 * planning preflight 失败包装的 IPC 源码契约测试。
 *
 *  与 recovery-strip-contract.test.ts 同源（无 jsdom / 无 React Testing Library）：
 *  读取 main.ts / derived.ts 的源码，断言：
 *   - runPlanning 的 preflight + runPlan 都在 try 块里；
 *   - catch 分支调用 buildPreflightFailureState、把失败 state 持久化、写
 *     taskStatus="failed" 的 assistant 消息、emit project、返回 status="failed"
 *     的正常 PlanningRunResult；
 *   - try 块必须包含项目存在性检查、API Key 解析、adapter 构造、runPlan
 *     调用、addMessage、emitProject；不再要求「safeStorage 解密」（已脱钩）。
 *   - planning:start 与 planning:resume 都委托给 runPlanning（共享包装，行为一致）；
 *   - renderer auto-start 在 result.status === "failed" 时调用 setPlanningState
 *     与 setNotice。
 *
 *  与 preflight-failure.test.ts（纯函数行为）配对：契约 + 行为都能被 CI 抓到回归。
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

/**
 * 给定源码 + 一个「关键字」起始索引，向后扫描到匹配的 `});`：
 *   - handler 起始：关键字后面跟着 `ipcMain.handle(... (event, ...) => {`
 *   - 起始大括号是关键字后第一个 `{`；
 *   - 简单括号计数，忽略字符串 / 注释里的 { 和 }；
 *   - 闭合 `});` 是匹配的 `}` + `)` + `;`。
 *
 *  这层简单扫描足够覆盖规划子系统的两个 handler（都只有一层函数体）。
 */
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
  // 此时 source[i-1] 应当是闭合大括号 `}`，source[i..i+1] 应当是闭合括号+分号 `);`。
  if (source[i - 1] !== "}") throw new Error("expected closing brace");
  if (source.slice(i, i + 2) !== ");") throw new Error("expected `);` to close handler");
  return source.slice(start, i + 2);
}

/**
 * 同上：定位 `function name(args) {` 后扫到匹配大括号闭合。
 */
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

const mainSrc = read("src/main/main.ts");
const helperSrc = read("src/main/planning/preflight-failure.ts");
const derivedSrc = read("src/renderer/app/state/derived.ts");

test("preflight-failure.ts 暴露 buildPreflightFailureState 纯函数", () => {
  assert.match(helperSrc, /export function buildPreflightFailureState/);
  assert.match(helperSrc, /export function classifyPreflightError/);
  assert.match(helperSrc, /export function redactSensitiveMessage/);
  assert.match(helperSrc, /export function composePreflightFailureReply/);
});

test("main.ts 的 runPlanning 用 try/catch 包裹 preflight + runPlan + completion handling", () => {
  const body = extractFunctionBody(mainSrc, "async function runPlanning(");
  assert.match(body, /try\s*\{/, "runPlanning 必须有 try 块");
  assert.match(body, /catch\s*\(\s*\w+\s*\)/, "runPlanning 必须有 catch 块");
  // try 块必须覆盖：项目存在性、API Key 解析、adapter 构造、runPlan、addMessage、emitProject。
  // 旧版要求 try 块里有 safeStorage 解密调用；新版本已脱钩 safeStorage，
  // 改为要求出现 aiKeyStore / apiKey(...) 任一以验证密钥解析仍在 try 保护范围内。
  const tryMatch = body.match(/try\s*\{([\s\S]*?)\}\s*catch\s*\(/);
  assert.ok(tryMatch, "必须有 try 块");
  const tryBody = tryMatch![1];
  assert.match(tryBody, /db\.getProject\(/);
  assert.match(tryBody, /apiKey\(/) ;
  assert.match(tryBody, /new OpenAICompatiblePlannerAdapter/);
  assert.match(tryBody, /runPlan\(/);
  assert.match(tryBody, /db\.addMessage/);
  assert.match(tryBody, /emitProject/);
});

test("main.ts 有 handlePreflightFailure 函数并被 runPlanning 的 catch 调用", () => {
  assert.match(mainSrc, /function handlePreflightFailure\(/, "main.ts 必须定义 handlePreflightFailure");
  // catch 块必须显式调用 handlePreflightFailure，而不是只 console.warn + return rejected。
  const runPlanningBody = extractFunctionBody(mainSrc, "async function runPlanning(");
  // catch 块 = 从 `catch (error) {` 起到 runPlanning 函数体末尾前的最后一个 `}`。
  const catchStart = runPlanningBody.search(/catch\s*\(\s*\w+\s*\)\s*\{/);
  assert.notEqual(catchStart, -1, "runPlanning 必须有 catch 块");
  const catchBody = runPlanningBody.slice(catchStart);
  assert.match(catchBody, /handlePreflightFailure\(/, "catch 必须调用 handlePreflightFailure");
});

test("handlePreflightFailure 持久化 failed state + 写 taskStatus='failed' 的 assistant 消息 + emit project + 返回正常 PlanningRunResult", () => {
  const body = extractFunctionBody(mainSrc, "function handlePreflightFailure(");
  assert.match(body, /buildPreflightFailureState\(/, "必须调用 buildPreflightFailureState 包装");
  assert.match(body, /savePlanningState\(/, "必须调 savePlanningState 持久化失败状态");
  assert.match(body, /addMessage\([^)]*assistant[^)]*failed/, "必须写 taskStatus='failed' 的 assistant 消息");
  assert.match(body, /emitProject\(/, "必须 emitProject");
  assert.match(body, /status:\s*["']failed["']/, "返回值必须 status='failed'");
  assert.match(body, /assistantReply:/, "返回值必须含 assistantReply");
  assert.match(body, /state:\s*failure\.state/, "返回值必须含持久化后的 state");
});

test("planning:start 与 planning:resume 都委托给 runPlanning 包装（共享行为）", () => {
  const startBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:start"');
  const resumeBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:resume"');
  assert.ok(startBody, "planning:start handler 必须存在");
  assert.ok(resumeBody, "planning:resume handler 必须存在");
  // 两个 handler 都必须调用 runPlanning(...)，不允许一个用 throw + IPC reject、另一个用 catch。
  assert.match(startBody, /runPlanning\(/, "planning:start 必须委托给 runPlanning");
  assert.match(resumeBody, /runPlanning\(/, "planning:resume 必须委托给 runPlanning");
  // start 在调 runPlanning 之前必须先写 pending 状态（既有的「fresh start」语义）。
  const startBeforeRunPlanning = startBody.split(/runPlanning\(/)[0];
  assert.ok(/savePlanningState\(/.test(startBeforeRunPlanning),
    "planning:start 必须在调 runPlanning 前持久化 pending 状态");
});

test("renderer auto-start 在 result.status==='failed' 时调用 setPlanningState + setNotice", () => {
  const autoStart = derivedSrc.match(/api\(\)!\.planning\.start[\s\S]*?\}\);/);
  assert.ok(autoStart, "auto-planning 块必须存在");
  const body = autoStart![0];
  assert.match(body, /setPlanningState\(result\.state\)/, "auto-start 必须把 result.state 写回 planningState");
  assert.match(body, /result\.status\s*===\s*["']failed["']/, "auto-start 必须检测 status==='failed'");
  assert.match(body, /setNotice\(/, "auto-start 必须在失败时 setNotice，让 recovery strip 有上下文");
});