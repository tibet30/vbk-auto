import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("主菜单固定为产品之后紧跟任务中心", () => {
  const rail = read("src/renderer/app/views/shell/Rail.tsx");
  const workspace = rail.indexOf('aria-label="工作台"');
  const products = rail.indexOf('aria-label="产品"');
  const tasks = rail.indexOf('aria-label="任务中心"');
  const logs = rail.indexOf('aria-label="运行日志"');
  assert.ok(workspace < products && products < tasks && tasks < logs);
});

test("任务中心、产品列表和产品详情共用后台任务状态", () => {
  const appView = read("src/renderer/app/views/AppView.tsx");
  const productList = read("src/renderer/app/helpers/components.tsx");
  const workspace = read("src/renderer/app/views/workspace/index.tsx");
  assert.match(appView, /view === "tasks"[\s\S]*<AppTasksPage/);
  assert.match(productList, /item\.workflowTask[\s\S]*productTaskTrack/);
  assert.match(workspace, /<WorkflowTaskStrip task=\{currentWorkflowTask\}/);
});

test("从任务进入详情时定位对应阶段并聚焦状态", () => {
  const action = read("src/renderer/app/actions/product.ts");
  const strip = read("src/renderer/app/views/workflow-task/TaskStrip.tsx");
  assert.match(action, /task\.stage === "automation" \|\| task\.stage === "completed" \? "vbk" : "review"/);
  assert.match(action, /getElementById\("workflow-task-status"\)\?\.focus\(\)/);
  assert.match(strip, /id="workflow-task-status"[\s\S]*tabIndex=\{-1\}/);
});

test("任务筛选和三处进度均暴露可访问状态", () => {
  const taskPage = read("src/renderer/app/views/tasks/index.tsx");
  const productList = read("src/renderer/app/helpers/components.tsx");
  const taskStrip = read("src/renderer/app/views/workflow-task/TaskStrip.tsx");
  assert.match(taskPage, /aria-pressed=\{filter === item\.key\}/);
  for (const source of [taskPage, productList, taskStrip]) {
    assert.match(source, /role="progressbar"[\s\S]*aria-valuenow=/);
  }
});

test("一键创建返回产品列表，后台调度不再由 products:create 同步等待", () => {
  const action = read("src/renderer/app/actions/product.ts");
  const ipc = read("src/main/ipc/remote-product-ipc.ts");
  assert.match(action, /setView\("products"\)/);
  assert.match(action, /后台任务已创建/);
  assert.match(ipc, /context\.enqueueProductTask\(initialProduct\)/);
  assert.doesNotMatch(ipc, /await runAutoConfirmedCreation/);
});

test("任务中心提供带二次确认的永久废弃入口且明确保留产品", () => {
  const taskPage = read("src/renderer/app/views/tasks/index.tsx");
  const api = read("src/shared/contracts-api.ts");
  assert.match(taskPage, /永久废弃任务/);
  assert.match(taskPage, /确认永久废弃/);
  assert.match(taskPage, /关联产品、携程草稿和历史执行记录不会删除/);
  assert.match(taskPage, /filter === "abandoned"/);
  assert.match(api, /abandon\(id: string\): Promise<ProductWorkflowTask>/);
});
