/**
 * main.ts IPC 接线契约测试 — 锁住四点修复的源码结构。
 *
 * 与 preflight-ipc-contract.test.ts 同源（无 jsdom / 无 RTL）：读取 main.ts
 * 源码，断言：
 *
 *   G1 · planning:start 必须先 load → 受限 restore → save pending → run，
 *       保证旧 failed/needs_user 的 blocked 产品在 fresh start 后能被
 *       syncProductStatusAfterRunPlan 正确推到 review（旧实现顺序错：
 *       save pending 先于 restore，会洗掉旧 state，新一轮 completed 走到
 *       syncProductStatusAfterRunPlan 时 product.status 还是 blocked，
 *       planning→review 推送被跳过，UI 永远停在 blocked）。
 *
 *   G2 · runPlanning 写入 assistant 消息的 taskStatus 必须跟 result.status
 *       走：completed → "succeeded"，failed/needs_user → "failed"。
 *       旧实现不论 result.status 都写 "succeeded"，把失败 / needs_user 轮
 *       误标成成功，recovery strip 与产品消息列表会同时出错。
 *
 *   G3 · handlePreflightFailure 写消息 / 同步 product.status / emit product
 *       三件事必须全部在 `if (product) { ... }` 守卫内；产品不存在时仍
 *       返回 status='failed' 的稳定结果，但不写 messages 行（避免孤儿
 *       local_product_id 破坏 conversations 反查产品的语义一致性）。
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
const repoRoot = path.resolve(__dirname, "../../..");

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

const mainSrc = [
  read("src/main/main.ts"),
  read("src/main/main-runtime.ts"),
  read("src/main/ipc/planning-ipc.ts"),
  read("src/main/ipc/planning-ipc/ipc-handlers.ts"),
  read("src/main/ipc/planning-ipc/run-planning.ts"),
  read("src/main/ipc/planning-ipc/preflight-failure.ts"),
  read("src/main/ipc/planning-ipc/stable-result.ts"),
  read("src/main/ipc/planning-ipc/postprocess.ts"),
].join("\n");
const productAiSrc = read("src/main/ipc/product-ai-ipc.ts");
const browserAutomationSrc = read("src/main/ipc/browser-automation-ipc.ts");
const planningV2Src = read("src/main/ipc/planning-v2-ipc.ts");
const workflowCoordinatorSrc = read("src/main/application/product-workflow-coordinator.ts");

// ──────────────────────────────────────────────────────────────────────────
// G1 — planning:start 必须先 load → 受限 restore → save pending → run
// ──────────────────────────────────────────────────────────────────────────

test("G5 · 旧 planning、AI 和 automation 入口统一委托 durable Agent", () => {
  assert.match(productAiSrc, /agentCore\.send\(localProductId, content\)/,
    "旧 ai:send 必须委托 Agent，避免建立第二套对话执行器");
  assert.match(productAiSrc, /agentCore\.pause\(localProductId\)/,
    "旧 ai:cancel 必须暂停同一个 Agent run");
  assert.match(planningV2Src, /requireAgent\(\)\.send\(localProductId,/,
    "planning:start 必须通过 Agent 启动");
  assert.match(planningV2Src, /agent\.resume\(localProductId\)/,
    "planning:resume 必须恢复现有 Agent run");
  assert.match(browserAutomationSrc, /Promise\.all\(\[[\s\S]*automation\.stop\(localProductId\)[\s\S]*agentCore\?\.pause\(localProductId\)/,
    "旧 automation:stop 必须同时停止旧 runner 并暂停 Agent");
  assert.match(workflowCoordinatorSrc, /private readonly active = new Map<string, ProductWorkflow>\(\)/,
    "协调器必须按产品记录当前长流程类型");
  assert.match(workflowCoordinatorSrc, /finally\s*\{[\s\S]*this\.active\.delete\(localProductId\)/,
    "成功或异常后都必须在 finally 释放产品锁");

  const startBody = extractHandlerBody(mainSrc, 'ipcMain.handle("planning:start"');
  const startGuardIdx = startBody.indexOf("assertPlanningIdle(localProductId)");
  const saveIdx = startBody.indexOf("savePlanningState(");
  assert.ok(startGuardIdx >= 0 && startGuardIdx < saveIdx,
    "planning:start 必须在覆盖 pending state 前拒绝并发请求");
});

test("G6 · ai:send 不再保留会与 Agent 重复写行程的旧实现", () => {
  assert.match(productAiSrc, /ipcMain\.handle\("ai:send"[\s\S]*agentCore\.send\(localProductId, content\)/,
    "兼容入口必须把原始用户意图交给 Agent");
  assert.doesNotMatch(productAiSrc, /runAiReply|patchTouchesItinerary|enrichItineraryPois|responsePersisted/,
    "旧 AI 行程写回链路必须删除，避免和 Agent 重复修改本地产品");
});

test("G7 · 重做和采用行程入口只向 Agent 提交意图", () => {
  const planningV2Ipc = read("src/main/ipc/planning-v2-ipc.ts");
  assert.match(planningV2Ipc, /planning:rerunMajorStage[\s\S]*sendPlanningIntent\(localProductId,/,
    "重做阶段必须变成 Agent 意图");
  assert.match(planningV2Ipc, /planning:acceptItineraryAndRerunCompletion[\s\S]*sendPlanningIntent\(localProductId,/,
    "采用行程必须变成 Agent 意图");
  assert.doesNotMatch(planningV2Ipc, /runThreeStagePlan|remoteProducts\.update|resetProductForPlanningStage/,
    "兼容入口不得隐藏执行旧三阶段 AI 或直接写远端");
});

test("手工复核字段先广播本地事务结果，再交给远端镜像同步", () => {
  const productAiSrc = read("src/main/ipc/product-ai-ipc.ts");
  assert.match(productAiSrc, /const saved = productMutations\.commands\.manualField[\s\S]*?broadcastProduct\(saved\);\s*emitProduct\(saved\);/,
    "手工删除/POI 保存不能等待远端镜像完成后才刷新界面");
});

test("POI IPC 详情日志将 rawPayload 序列化为字符串", () => {
  const source = read("src/main/ipc/browser-automation-ipc.ts");
  assert.match(source, /rawPayload: stringifyPoiPayloadForLog\(result\.rawPayload\)/);
  assert.match(source, /function stringifyPoiPayloadForLog\(value: unknown\): string/);
});
