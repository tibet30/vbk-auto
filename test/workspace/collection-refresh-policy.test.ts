import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  shouldApplyCollectionUpdate,
  shouldApplyProductUpdate,
  shouldApplyWorkflowTaskDetailUpdate,
  shouldHandleVbkPageReady,
  shouldRefreshCollections,
} from "../../src/renderer/app/state/collection-refresh-policy.ts";

test("只有进入产品列表或任务中心时才拉取集合快照", () => {
  assert.equal(shouldRefreshCollections("products"), true);
  assert.equal(shouldRefreshCollections("products", true), false);
  assert.equal(shouldRefreshCollections("tasks"), true);
  assert.equal(shouldRefreshCollections("workspace"), false);
  assert.equal(shouldRefreshCollections("settings"), false);
  assert.equal(shouldRefreshCollections("operation-log"), false);
});

test("后台产品更新只应用到当前打开的产品详情", () => {
  assert.equal(shouldApplyProductUpdate("workspace", "product-1", "product-1"), true);
  assert.equal(shouldApplyProductUpdate("workspace", "product-1", "product-2"), false);
  assert.equal(shouldApplyProductUpdate("products", "product-1", "product-1"), false);
  assert.equal(shouldApplyProductUpdate("tasks", "product-1", "product-1"), false);
});

test("实时集合事件只在可见列表应用，新建表单保持静默", () => {
  assert.equal(shouldApplyCollectionUpdate("products"), true);
  assert.equal(shouldApplyCollectionUpdate("products", true), false);
  assert.equal(shouldApplyCollectionUpdate("tasks"), true);
  assert.equal(shouldApplyCollectionUpdate("workspace"), false);
  assert.equal(shouldApplyWorkflowTaskDetailUpdate("workspace", "product-1", "product-1"), true);
  assert.equal(shouldApplyWorkflowTaskDetailUpdate("workspace", "product-1", "product-2"), false);
});

test("后台 VBK 页面跳转不能刷新产品表单或列表页", () => {
  assert.equal(shouldHandleVbkPageReady("workspace"), true);
  assert.equal(shouldHandleVbkPageReady("products"), false);
  assert.equal(shouldHandleVbkPageReady("tasks"), false);
  assert.equal(shouldHandleVbkPageReady("settings"), false);
});

test("后台任务状态通过受控事件实时更新，列表接口负责进入页面时补偿", () => {
  const main = readFileSync("src/main/main.ts", "utf8");
  const preload = readFileSync("src/main/preload.cts", "utf8");
  const api = readFileSync("src/shared/contracts-api.ts", "utf8");
  const derived = readFileSync("src/renderer/app/state/derived.ts", "utf8");
  const liveUpdates = readFileSync("src/renderer/app/state/collection-live-updates.ts", "utf8");

  assert.match(main, /workflow-task:updated/);
  assert.match(main, /const completedTask = db\?\.completeWorkflowTaskForProduct\(product\);[\s\S]*if \(completedTask\) emitWorkflowTask\(completedTask\);/);
  assert.match(preload, /onWorkflowTaskUpdated/);
  assert.match(api, /onWorkflowTaskUpdated/);
  assert.match(derived, /subscribeCollectionLiveUpdates/);
  assert.match(liveUpdates, /onWorkflowTaskUpdated/);
  assert.match(liveUpdates, /shouldApplyCollectionUpdate\(current\.view, current\.creating\)/);
  assert.match(derived, /shouldRefreshCollections\(view, creating\)[\s\S]*refreshRef\.current\(\)/);
  const base = readFileSync("src/renderer/app/state/base.ts", "utf8");
  assert.match(base, /requestScope = collectionScopeRef\.current[\s\S]*collectionScopeRef\.current !== requestScope/);
});
