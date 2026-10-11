/**
 * 规划进度 IPC event 契约。
 * 规划状态只在首次打开产品时 lookup；后续状态必须从主进程持久化后的事件到达。
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
const main = [
  read("src/main/main.ts"),
  read("src/main/main-events.ts"),
].join("\n");
const planningIpc = [
  read("src/main/ipc/planning-ipc.ts"),
  read("src/main/ipc/planning-ipc/preflight-failure.ts"),
  read("src/main/ipc/planning-ipc/ipc-handlers.ts"),
  read("src/main/ipc/planning-ipc/run-planning.ts"),
].join("\n");
const runtime = read("src/main/planning/runtime.ts");
const derived = read("src/renderer/app/state/derived.ts");

test("planning:updated 作为受控 IPC event 完整穿过 contracts、preload 和 main", () => {
  assert.match(contracts, /onPlanningStateUpdated\(listener:\s*\(localProductId:\s*string,\s*state:\s*PlanningGenerationState\)\s*=>\s*void\):\s*\(\)\s*=>\s*void/);
  assert.match(preload, /onPlanningStateUpdated\(listener\)[\s\S]*?ipcRenderer\.on\("planning:updated", handler\)[\s\S]*?removeListener\("planning:updated", handler\)/);
  assert.match(main, /safeRendererSend\(window,\s*"planning:updated",\s*state\.localProductId,\s*state\)/,
    "main 必须通过安全 renderer 发送封装广播合法的 localProductId 和 state 参数");
  const emitBody = main.match(/const emitPlanningState = \(state: PlanningGenerationState\) => \{([\s\S]*?)\n\s*\};/);
  assert.ok(emitBody, "必须存在 planning:updated 发送函数");
  assert.match(emitBody![1], /safeRendererSend\(window,\s*"planning:updated",\s*state\.localProductId,\s*state\)/,
    "planning:updated 必须由安全 renderer 发送封装按事件契约广播");
});

test("状态只在成功落库后广播，编排器和 IPC 直写路径各一写一播", () => {
  assert.match(runtime, /this\.db\.savePlanningState\(state\);\s*\n\s*this\.onSaved\?\.\(state\);/);
  assert.match(planningIpc, /new DbGenerationStateStore\(db, emitPlanningState\)/);
  assert.match(planningIpc, /db\.savePlanningState\(failure\.state\);\s*\n\s*emitPlanningState\(failure\.state\);/);
  assert.match(planningIpc, /db\.savePlanningState\(pendingState\);\s*\n\s*emitPlanningState\(pendingState\);/);
});

test("renderer 订阅按产品隔离的版本快照，卸载后取消订阅", () => {
  const subscription = read("src/renderer/app/state/workspace-planning-subscription.ts");
  assert.match(derived, /useWorkspacePlanning/);
  assert.match(subscription, /snapshot.localProductId === id/);
  assert.match(subscription, /alive = false; unsubscribe\(\)/);
  const store = read("src/renderer/app/state/workspace-snapshot-store.ts");
  assert.match(store, /snapshot.viewRevision <= old.viewRevision/);
});

test("首次读取、重连与订阅使用同一快照合并规则，不建立规划轮询", () => {
  const subscription = read("src/renderer/app/state/workspace-planning-subscription.ts");
  assert.match(subscription, /workspaceSnapshots.read\(client, id\)/);
  assert.match(subscription, /addEventListener\('focus', refresh\)/);
  assert.doesNotMatch(subscription, /setInterval|pollerRef/);
});
