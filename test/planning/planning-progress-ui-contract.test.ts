/**
 * 规划进度 IPC event 契约。
 * 规划状态只在首次打开项目时 lookup；后续状态必须从主进程持久化后的事件到达。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const contracts = read("src/shared/contracts-api.ts");
const preload = read("src/main/preload.cts");
const main = read("src/main/main.ts");
const runtime = read("src/main/planning/runtime.ts");
const derived = read("src/renderer/app/state/derived.ts");

test("planning:updated 作为受控 IPC event 完整穿过 contracts、preload 和 main", () => {
  assert.match(contracts, /onPlanningStateUpdated\(listener:\s*\(projectId:\s*string,\s*state:\s*PlanningGenerationState\)\s*=>\s*void\):\s*\(\)\s*=>\s*void/);
  assert.match(preload, /onPlanningStateUpdated\(listener\)[\s\S]*?ipcRenderer\.on\("planning:updated", handler\)[\s\S]*?removeListener\("planning:updated", handler\)/);
  assert.match(main, /window\.webContents\.send\("planning:updated", state\.projectId, state\)/);
  const emitBody = main.match(/const emitPlanningState = \(state: PlanningGenerationState\) => \{([\s\S]*?)\n\};/);
  assert.ok(emitBody, "必须存在 planning:updated 发送函数");
  assert.match(emitBody![1], /try\s*\{[\s\S]*?webContents\.send[\s\S]*?\}\s*catch/,
    "窗口在 isDestroyed 检查后销毁时，发送失败不得中断规划任务");
});

test("状态只在成功落库后广播，编排器和 IPC 直写路径各一写一播", () => {
  assert.match(runtime, /this\.db\.savePlanningState\(state\);\s*\n\s*this\.onSaved\?\.\(state\);/);
  assert.match(main, /new DbGenerationStateStore\(db, emitPlanningState\)/);
  assert.match(main, /db\.savePlanningState\(failure\.state\);\s*\n\s*emitPlanningState\(failure\.state\);/);
  assert.match(main, /db\.savePlanningState\(pendingState\);\s*\n\s*emitPlanningState\(pendingState\);/);
});

test("renderer 订阅实时事件，按当前 projectId 防串扰，卸载时取消订阅", () => {
  const subscription = derived.match(/const unsubscribePlanning = api\(\)!\.events\.onPlanningStateUpdated\([\s\S]*?unsubscribePlanning\(\);/);
  assert.ok(subscription, "必须订阅并在 cleanup 时取消 planning:updated");
  assert.match(subscription![0], /currentProjectIdRefForPlanning\.current !== projectId/);
  assert.match(subscription![0], /planningEventVersionRef\.current \+= 1/,
    "收到当前项目的实时状态后必须推进版本，防止旧 lookup 覆盖新事件");
  assert.match(subscription![0], /setPlanningState\(next\)/);
  assert.match(subscription![0], /setPlanningStateLoadedProjectId\(projectId\)/);
});

test("首次进入项目只做单次 planning.state 补偿，运行期不得建立 planning interval", () => {
  assert.match(derived, /api\(\)!\.planning\.state\(capturedId\)/);
  assert.match(derived, /\}, \[project\?\.id\]\);/);
  assert.match(derived, /eventVersionAtLookup/,
    "单次补偿必须在实时事件先到时丢弃旧快照，不能覆盖实时进度");
  assert.match(derived, /planningEventVersionRef\.current !== eventVersionAtLookup/);
  assert.doesNotMatch(derived, /PLANNING_POLL_INTERVAL_MS|pollOnce|pollerRef|setInterval\(pollOnce/);
});
