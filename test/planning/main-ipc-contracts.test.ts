/**
 * main.ts IPC 接线契约测试 — 锁住四点修复的源码结构。
 *
 * 与 preflight-ipc-contract.test.ts 同源（无 jsdom / 无 RTL）：读取 main.ts
 * 源码，断言：
 *
 *   G1 · planning:start 必须先 load → 受限 restore → save pending → run，
 *       保证旧 failed/needs_user 的 blocked 项目在 fresh start 后能被
 *       syncProjectStatusAfterRunPlan 正确推到 review（旧实现顺序错：
 *       save pending 先于 restore，会洗掉旧 state，新一轮 completed 走到
 *       syncProjectStatusAfterRunPlan 时 project.status 还是 blocked，
 *       planning→review 推送被跳过，UI 永远停在 blocked）。
 *
 *   G2 · runPlanning 写入 assistant 消息的 taskStatus 必须跟 result.status
 *       走：completed → "succeeded"，failed/needs_user → "failed"。
 *       旧实现不论 result.status 都写 "succeeded"，把失败 / needs_user 轮
 *       误标成成功，recovery strip 与项目消息列表会同时出错。
 *
 *   G3 · handlePreflightFailure 写消息 / 同步 project.status / emit project
 *       三件事必须全部在 `if (project) { ... }` 守卫内；项目不存在时仍
 *       返回 status='failed' 的稳定结果，但不写 messages 行（避免孤儿
 *       project_id 破坏 conversations 反查项目的语义一致性）。
 *
 *   G4 · planning:resume 必须先 load state：
 *         - 持久化记录不存在 → 直接抛错（不接受盲跑等同 planning:start）；
 *         - 持久化 status='completed'、全部阶段已完成且 itinerary POI 齐全 → 返回
 *           buildStableCompletedResult 拼出的稳定 PlanningRunResult；若仍有空 POI，
 *           必须继续进入 runPlanning 的 completed backfill 分支，且不重跑 AI；
 *           completed 但阶段不全也必须继续走恢复路径；
 *         - 其他状态 → 受限 restore 后才调 runPlanning。
 *
 *  本文件不动 main.ts / planning 模块，只读源码做白盒断言；不依赖 jsdom、
 *  electron、better-sqlite3；运行 npm run check / 单测时一并跑过。
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
 * 提取 ipcMain.handle("key", (event, ...) => { ... }) 函数体（不含外层分号）。
 * 用简单括号计数扫到匹配的 `});`，与 preflight-ipc-contract.test.ts 的
 * extractHandlerBody 等价；本文件单独保留避免跨文件耦合。
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
  if (source[i - 1] !== "}") throw new Error("expected closing brace");
  if (source.slice(i, i + 2) !== ");") throw new Error("expected `);` to close handler");
  return source.slice(start, i + 2);
}

/**
 * 定位 `function name(args) {` 后扫到匹配大括号闭合（含外层函数声明）。
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

// ──────────────────────────────────────────────────────────────────────────
// G1 — planning:start 必须先 load → 受限 restore → save pending → run
// ──────────────────────────────────────────────────────────────────────────

test("G1 · planning:start 在 save pending 之前必须先 loadPlanningState", () => {
  const startBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:start"');
  assert.ok(startBody, "planning:start handler 必须存在");
  const loadIdx = startBody.indexOf("loadPlanningState(");
  const saveIdx = startBody.indexOf("savePlanningState(");
  assert.notEqual(loadIdx, -1, "planning:start 必须先调用 loadPlanningState 查旧状态");
  assert.notEqual(saveIdx, -1, "planning:start 必须调用 savePlanningState 写新 pending");
  assert.ok(loadIdx < saveIdx, "loadPlanningState 必须在 savePlanningState 之前调用；顺序倒了会让 pending 直接覆盖旧 failed/needs_user");
});

test("G1 · planning:start 必须把 load 出来的 status 喂给 restoreProjectToPlanningForRetry，且 restore 在 save 之前", () => {
  const startBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:start"');
  assert.ok(startBody, "planning:start handler 必须存在");
  // restore 调用必须存在
  assert.match(startBody, /restoreProjectToPlanningForRetry\(/, "planning:start 必须调 restoreProjectToPlanningForRetry");
  // restore 必须在 save pending 之前；save pending 是第一个未嵌套的 savePlanningState 调用，
  // 用 lastIndexOf("savePlanningState") 拿末尾出现的位置（restore 在它前面）。
  const restoreIdx = startBody.indexOf("restoreProjectToPlanningForRetry(");
  const saveIdx = startBody.indexOf("savePlanningState(");
  assert.ok(restoreIdx < saveIdx, "restoreProjectToPlanningForRetry 必须在 save pending 之前；否则旧状态会被覆盖，恢复无从触发");
  // 必须把 existingState.status 作为参数传进去（不是 hardcode 常量）。
  const restoreCall = startBody.slice(restoreIdx, startBody.indexOf(";", restoreIdx) + 1);
  assert.match(restoreCall, /restoreProjectToPlanningForRetry\(\s*\w+\s*,\s*\w+\s*,\s*[\w.]+\s*\)/,
    "restoreProjectToPlanningForRetry 必须接 db + projectId + state.status 三个参数，不能 hardcode 状态");
  assert.match(restoreCall, /existingState\.status|\.status/,
    "restoreProjectToPlanningForRetry 的状态参数必须来自 load 出来的 state.status，不能是字符串常量");
});

test("G1 · planning:start restore 调用必须有「先 load 再 restore」的 if 守卫", () => {
  const startBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:start"');
  // 期望写法：`if (existingState) { restoreProjectToPlanningForRetry(...) }`，
  // 否则项目无持久化记录时调用 restore 会被空值击穿（shouldRestoreProjectToPlanning
  // 在 planningGenerationStatus=undefined 时本就不会 apply，但语义上仍应显式守卫）。
  assert.match(startBody, /if\s*\(\s*existingState\s*\)\s*\{[\s\S]*restoreProjectToPlanningForRetry\(/,
    "restore 必须包在 if (existingState) 守卫内，避免无持久化记录时做无效恢复");
});

// ──────────────────────────────────────────────────────────────────────────
// G2 — runPlanning 写入 assistant 消息的 taskStatus 必须随 result.status 分支
// ──────────────────────────────────────────────────────────────────────────

test("G2 · runPlanning 的 addMessage taskStatus 必须是 result.status 条件表达式，不是固定字符串", () => {
  const body = extractFunctionBody(mainSrc, "async function runPlanning(");
  assert.match(body, /try\s*\{/, "runPlanning 必须有 try 块");
  const tryMatch = body.match(/try\s*\{([\s\S]*?)\}\s*catch\s*\(/);
  assert.ok(tryMatch, "必须有 try 块");
  const tryBody = tryMatch![1];
  // 必须存在 addMessage 调用，role="assistant"
  assert.match(tryBody, /db\.addMessage\(\s*projectId\s*,\s*["']assistant["']\s*,/, "runPlanning 必须 addMessage(..., assistant, ...)");
  // 4th 参数（taskStatus）必须是表达式，不能是字面量字符串常量
  // 旧写法：db.addMessage(projectId, "assistant", result.assistantReply, "succeeded") → taskStatus 是固定 "succeeded"
  // 新写法：db.addMessage(projectId, "assistant", result.assistantReply, replyMessageTaskStatus) → taskStatus 是变量
  //     或：db.addMessage(projectId, "assistant", result.assistantReply, result.status === "completed" ? "succeeded" : "failed")
  // 两种写法都禁止直接传 "succeeded" / "failed" 字面量。
  const addMessageCall = tryBody.match(/db\.addMessage\(\s*projectId\s*,\s*["']assistant["']\s*,\s*[^,]+,\s*([^)]+)\)/);
  assert.ok(addMessageCall, "必须解析到 addMessage 调用并捕获 taskStatus 实参");
  const taskStatusArg = addMessageCall![1].trim();
  assert.notEqual(taskStatusArg, '"succeeded"', "taskStatus 不能是字面量 'succeeded'，旧 bug 会让 failed/needs_user 也被标 succeeded");
  assert.notEqual(taskStatusArg, '"failed"', "taskStatus 不能是字面量 'failed'，那样 completed 也会被标 failed");
  assert.notEqual(taskStatusArg, "'succeeded'", "taskStatus 不能是字面量 'succeeded'");
  assert.notEqual(taskStatusArg, "'failed'", "taskStatus 不能是字面量 'failed'");
  // 必须是变量名或三元表达式，且引用 result.status。
  assert.match(taskStatusArg, /result\.status|replyMessageTaskStatus/,
    "taskStatus 必须是变量或含 result.status 的三元表达式，使消息状态跟 result.status 走");
});

test("G2 · runPlanning 显式声明 replyMessageTaskStatus 三元表达式，把 completed 映射到 succeeded", () => {
  const body = extractFunctionBody(mainSrc, "async function runPlanning(");
  // 期望：const replyMessageTaskStatus = result.status === "completed" ? "succeeded" : "failed";
  assert.match(body, /replyMessageTaskStatus[^=]*=\s*result\.status\s*===\s*["']completed["']\s*\?\s*["']succeeded["']\s*:\s*["']failed["']/,
    "必须显式声明 replyMessageTaskStatus，并把 result.status === 'completed' 映射到 'succeeded'，否则映射到 'failed'");
});

// ──────────────────────────────────────────────────────────────────────────
// G3 — handlePreflightFailure 写消息 / 同步 project.status / emit project
//      必须全部在 if (project) 守卫内
// ──────────────────────────────────────────────────────────────────────────

test("G3 · handlePreflightFailure 写消息前必须先取 project 引用", () => {
  const body = extractFunctionBody(mainSrc, "function handlePreflightFailure(");
  assert.match(body, /const project\s*=\s*db\.getProject\(/, "handlePreflightFailure 必须先 db.getProject(projectId) 拿项目引用");
  // project 引用必须在 addMessage 之前拿到，否则守卫无法成立
  const projectIdx = body.indexOf("const project = db.getProject(");
  const addMessageIdx = body.indexOf("db.addMessage(");
  assert.ok(projectIdx >= 0 && addMessageIdx >= 0, "必须存在 project 引用与 addMessage 调用");
  assert.ok(projectIdx < addMessageIdx, "project 引用必须在 addMessage 之前声明");
});

test("G3 · handlePreflightFailure 的 addMessage / sync / emit 必须全部在 if (project) 块内", () => {
  const body = extractFunctionBody(mainSrc, "function handlePreflightFailure(");
  // 抽取 `if (project) { ... }` 块（最朴素一层花括号计数即可，因为本函数内只有
  // 一处 if (project) 且块内不再嵌套其他 if）。
  const guardStart = body.search(/if\s*\(\s*project\s*\)\s*\{/);
  assert.notEqual(guardStart, -1, "handlePreflightFailure 必须有 if (project) 守卫");
  const open = body.indexOf("{", guardStart);
  let depth = 1;
  let i = open + 1;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) throw new Error("if (project) 块大括号不平衡");
  const guardBody = body.slice(open, i - 1);
  assert.match(guardBody, /db\.addMessage\(/, "if (project) 块内必须 addMessage");
  assert.match(guardBody, /syncProjectStatusAfterFailure\(/, "if (project) 块内必须 syncProjectStatusAfterFailure");
  assert.match(guardBody, /emitProject\(/, "if (project) 块内必须 emitProject");
});

test("G3 · handlePreflightFailure 项目不存在时仍返回 status='failed' 的稳定结果", () => {
  const body = extractFunctionBody(mainSrc, "function handlePreflightFailure(");
  // 函数末尾必须仍然构造 status: "failed" 的返回值，且含 assistantReply / state
  assert.match(body, /return\s*\{[\s\S]*status:\s*["']failed["']/, "无项目路径必须仍返回 status='failed' 的 PlanningRunResult");
  assert.match(body, /return\s*\{[\s\S]*assistantReply:/, "返回对象必须含 assistantReply");
  assert.match(body, /return\s*\{[\s\S]*state:\s*failure\.state/, "返回对象必须含持久化的 state");
  // db.savePlanningState 必须无条件执行（即使项目不存在也要写失败 state）
  assert.match(body, /db\.savePlanningState\(\s*failure\.state\s*\)/, "db.savePlanningState 必须无条件写失败 state");
});

// ──────────────────────────────────────────────────────────────────────────
// G4 — planning:resume 必须先 load state；不存在抛错；completed 短回路
// ──────────────────────────────────────────────────────────────────────────

test("G4 · planning:resume 必须先 loadPlanningState，throw if 不存在", () => {
  const resumeBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:resume"');
  assert.ok(resumeBody, "planning:resume handler 必须存在");
  // load 必须出现
  assert.match(resumeBody, /loadPlanningState\(/, "planning:resume 必须先 loadPlanningState");
  // load 必须在 throw 之前（顺序：load → 检查 → throw）
  const loadIdx = resumeBody.indexOf("loadPlanningState(");
  const throwIdx = resumeBody.search(/throw\s+new\s+Error/);
  assert.notEqual(throwIdx, -1, "planning:resume 在无持久化 state 时必须 throw，不能静默处理");
  assert.ok(loadIdx < throwIdx, "loadPlanningState 必须在 throw 之前");
  // throw 必须在 early return / if (!existingState) 分支内
  const beforeThrow = resumeBody.slice(0, throwIdx);
  assert.match(beforeThrow, /if\s*\(\s*!\s*existingState\s*\)\s*\{[\s\S]*$/,
    "throw 必须包在 if (!existingState) 守卫内；缺少守卫会让 throw 在所有路径都触发");
  // 错误信息必须明确告诉调用方改走 planning:start
  const throwLine = resumeBody.slice(throwIdx, resumeBody.indexOf(";", throwIdx) + 1);
  assert.match(throwLine, /planning:start/, "错误信息必须提示调用方改用 planning:start");
});

test("G4 · planning:resume 必须有 buildStableCompletedResult 拼装稳定 completed 结果", () => {
  const mainSrcText = mainSrc;
  // 必须存在该函数声明
  assert.match(mainSrcText, /function buildStableCompletedResult\(/,
    "main.ts 必须定义 buildStableCompletedResult 函数");
  // 该函数必须返回 PlanningRunResult 形状：state / status='completed' / accepted / rejected / assistantReply
  const helperBody = extractFunctionBody(mainSrcText, "function buildStableCompletedResult(");
  assert.match(helperBody, /status:\s*["']completed["']/, "buildStableCompletedResult 必须返回 status='completed'");
  assert.match(helperBody, /state\s*,/, "返回对象必须含 state 字段");
  assert.match(helperBody, /assistantReply:/, "返回对象必须含 assistantReply");
  assert.match(helperBody, /accepted/, "返回对象必须含 accepted 数组");
  assert.match(helperBody, /rejected/, "返回对象必须含 rejected 数组");
});

test("G4 · planning:resume 仅在 completed、所有阶段完成且 POI 齐全时短路", () => {
  const resumeBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:resume"');
  // 必须有 `existingState.status === "completed"` 分支
  const completedBranchIdx = resumeBody.search(/existingState\.status\s*===\s*["']completed["']/);
  assert.notEqual(completedBranchIdx, -1, "planning:resume 必须显式判断 existingState.status === 'completed'");
  // completed 不能单独成为短路条件；必须同时覆盖 PLANNING_STAGES 全集与 POI 完整性。
  const completedBranch = resumeBody.slice(completedBranchIdx, resumeBody.indexOf("return buildStableCompletedResult(", completedBranchIdx));
  assert.match(completedBranch, /allStagesCompleted/,
    "completed 分支必须同时判断 allStagesCompleted，避免部分完成状态被错误短路");
  assert.match(completedBranch, /!projectHasIncompletePois/,
    "completed 分支必须要求 POI 齐全，避免历史 completed 草稿跳过 POI 回填");
  assert.match(resumeBody, /PLANNING_STAGES\.every\([\s\S]*completedStages\.includes/,
    "planning:resume 必须以 PLANNING_STAGES 全集判断是否真实完成");
  assert.match(resumeBody, /hasIncompleteItineraryPois\(db\.getProject\(projectId\)\?\.product\s*\?\?\s*\{\}\)/,
    "planning:resume 必须基于当前持久化产品判断 POI 是否仍缺失");
  // completed 分支内必须返回 buildStableCompletedResult(existingState)
  assert.match(resumeBody, /return\s+buildStableCompletedResult\(\s*existingState\s*\)/,
    "真实全完成分支必须 return buildStableCompletedResult(existingState)，不接受其他形式");
  // 关键：completed 分支不能出现在 runPlanning( 调用之前之后——必须独立分支。
  // 简化为断言：在 resume handler 内存在两段独立的 return；一段是 completed 短回路，
  // 另一段是其他状态下先 restoreProjectToPlanningForRetry 再 return runPlanning(...)。
  // 这里用更宽松的检查：completed 分支的 return 之后 runPlanning( 至少还要出现一次（其他状态的分支）。
  const completedReturnIdx = resumeBody.indexOf("return buildStableCompletedResult(");
  const runPlanningIdx = resumeBody.indexOf("runPlanning(", completedReturnIdx);
  assert.notEqual(completedReturnIdx, -1, "completed 分支必须有 return buildStableCompletedResult");
  assert.notEqual(runPlanningIdx, -1,
    "planning:resume 在 completed 快速返回外必须有 runPlanning(...) 调用，供空 POI 与其他可恢复状态进入回填/恢复路径");
});

test("G4 · planning:resume 非 completed 状态必须先 restoreProjectToPlanningForRetry 再 return runPlanning", () => {
  const resumeBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:resume"');
  // completed 短回路之后必须还有 restoreProjectToPlanningForRetry + runPlanning 的路径
  const completedReturnIdx = resumeBody.indexOf("return buildStableCompletedResult(");
  assert.notEqual(completedReturnIdx, -1, "completed 短回路必须先存在");
  const afterCompleted = resumeBody.slice(completedReturnIdx);
  assert.match(afterCompleted, /restoreProjectToPlanningForRetry\(/,
    "completed 短回路之后必须有 restoreProjectToPlanningForRetry 调用（其他状态走的路径）");
  assert.match(afterCompleted, /return\s+runPlanning\(/,
    "非 completed 状态必须 return runPlanning(...)");
  // restore 必须在 runPlanning 之前
  const restoreIdx = afterCompleted.indexOf("restoreProjectToPlanningForRetry(");
  const runPlanningIdx = afterCompleted.indexOf("return runPlanning(");
  assert.ok(restoreIdx < runPlanningIdx,
    "非 completed 路径下 restoreProjectToPlanningForRetry 必须在 return runPlanning 之前");
});

test("G4 · completed POI 回填只暴露名称纠正器，不会调用规划阶段生成", () => {
  const body = extractFunctionBody(mainSrc, "async function runPlanning(");
  const backfillIdx = body.indexOf("isCompletedPoiOnlyBackfill");
  assert.notEqual(backfillIdx, -1, "runPlanning 必须显式识别已完成的 POI-only 回填");
  assert.match(body, /hasIncompleteItineraryPois\(product\)/,
    "仅全阶段 completed 且当前产品仍缺 POI 时才能走 POI-only 回填");
  assert.match(body, /completedPoiBackfillPlanner\(projectId\)/,
    "completed 回填必须使用专用 planner 装配，不可落入正常规划 adapter");

  const helperStart = mainSrc.indexOf("async function completedPoiBackfillPlanner(");
  const helperEnd = mainSrc.indexOf("/**", helperStart + 1);
  assert.notEqual(helperStart, -1, "completed POI 回填专用 planner 必须存在");
  assert.notEqual(helperEnd, -1, "completed POI 回填专用 planner 后必须保留模块边界");
  const helper = mainSrc.slice(helperStart, helperEnd);
  assert.match(helper, /已完成 POI 回填不应调用 AI planner/,
    "POI-only 回填必须使用不可调用的 generateStage，防止重跑 AI 规划阶段");
  assert.match(helper, /hasActiveKey/,
    "仅在当前 provider 已配置 Key 时，completed 回填才应请求 AI 名称纠正");
  assert.match(helper, /resolverAdapter\.resolvePoiName\.bind\(resolverAdapter\)/,
    "configured completed 回填必须只暴露 resolvePoiName 给 POI 三次纠正逻辑");
  assert.match(helper, /poi_backfill\.resolver_unavailable/,
    "Key 解密失败不能把 completed 项目写为 failed，必须降级为人工核查回填");
  assert.doesNotMatch(helper, /planner\s*=\s*resolverAdapter/,
    "completed 回填不可把完整 adapter 交给 runPlan，否则 generateStage 可能被调用");
});

test("G5 · 主进程以项目维度锁住 start / resume 的并发规划", () => {
  const runPlanningBody = extractFunctionBody(mainSrc, "async function runPlanning(");
  assert.match(mainSrc, /const activePlanningProjectIds\s*=\s*new Set<string>\(\)/,
    "必须维护按项目区分的运行锁，不能只依赖 renderer disabled");
  const guardIdx = runPlanningBody.indexOf("assertPlanningIdle(projectId)");
  const addIdx = runPlanningBody.indexOf("activePlanningProjectIds.add(projectId)");
  const tryIdx = runPlanningBody.indexOf("try {");
  const finallyIdx = runPlanningBody.indexOf("finally {");
  const deleteIdx = runPlanningBody.indexOf("activePlanningProjectIds.delete(projectId)");
  assert.ok(guardIdx >= 0 && guardIdx < addIdx && addIdx < tryIdx,
    "runPlanning 必须在进入 try/preflight 前取得运行锁，避免重入被写成 failed");
  assert.ok(finallyIdx >= 0 && finallyIdx < deleteIdx,
    "规划结束后必须在 finally 释放锁，避免失败后永久无法恢复");

  const startBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:start"');
  const startGuardIdx = startBody.indexOf("assertPlanningIdle(projectId)");
  const saveIdx = startBody.indexOf("savePlanningState(");
  assert.ok(startGuardIdx >= 0 && startGuardIdx < saveIdx,
    "planning:start 必须在覆盖 pending state 前拒绝并发请求");
});
