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

test("任务中心和产品列表共用后台任务状态，详情由 Agent 展示执行状态", () => {
  const appView = read("src/renderer/app/views/AppView.tsx");
  const productList = read("src/renderer/app/helpers/components.tsx");
  const workspace = read("src/renderer/app/views/workspace/index.tsx");
  const review = read("src/renderer/app/views/workspace/review.tsx");
  const agentConversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  assert.match(appView, /view === "tasks"[\s\S]*<AppTasksPage/);
  assert.match(productList, /item\.workflowTask[\s\S]*productTaskTrack/);
  assert.match(workspace, /stage === "vbk" \? <WorkflowTaskStrip task=\{currentWorkflowTask\}/);
  assert.match(review, /<AgentConversation/);
  assert.match(agentConversation, /useAgentSession\(product\.id, client\)/);
});

test("从任务进入详情时定位对应阶段并聚焦状态", () => {
  const action = read("src/renderer/app/actions/product.ts");
  const strip = read("src/renderer/app/views/workflow-task/TaskStrip.tsx");
  assert.match(action, /task\.stage === "automation" \|\| task\.stage === "completed" \? "vbk" : "review"/);
  assert.match(action, /getElementById\("workflow-task-status"\)\?\.focus\(\)/);
  assert.match(strip, /id="workflow-task-status"[\s\S]*tabIndex=\{-1\}/);
});

test("方案对话展示自动录入 recovery 中的完整报错详情", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  const styles = read("src/renderer/app/views/workspace/agent-conversation.module.less");
  assert.match(conversation, /latestAutomationFailure\(product\)/);
  assert.match(conversation, /automation\?\.recovery\?\.phases/);
  assert.match(conversation, /automationFailureAnchorIndex\(timelineItems, events\)/);
  assert.match(conversation, /aria-label="录入报错详情"/);
  assert.match(conversation, /\{failure\.message\}/);
  assert.match(styles, /\.failureNotice p[\s\S]*white-space: pre-wrap/);
});

test("非法关键词报错在对话列表中提供 AI 重写按钮", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  const styles = read("src/renderer/app/views/workspace/agent-conversation.module.less");
  assert.match(conversation, /index === failureAnchorIndex[\s\S]*<FailureNotice/);
  assert.match(conversation, /记录黑名单并重写图文/);
  assert.match(conversation, /buildIllegalKeywordRepairPrompt/);
  assert.match(conversation, /非法关键词\[：:\]/);
  assert.match(conversation, /findAffectedPresentationPaths\(product\.product, keywords\)/);
  assert.match(conversation, /repairingKeywords/);
  assert.match(conversation, /illegalKeywordRepairRequested/);
  assert.match(conversation, /illegalKeywordRepairSubmitted/);
  assert.match(conversation, /presentation\.cover\.description/);
  assert.match(conversation, /正在处理…/);
  assert.match(conversation, /已提交重写/);
  assert.match(conversation, /agent\.repairIllegalKeywords\(product\.id/);
  assert.match(styles, /\.failureNotice \{[\s\S]*align-self: flex-start/);
  assert.match(styles, /\.repairAction/);
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

test("一键创建进入 Agent 工作区，并先建任务记录再启动 Agent", () => {
  const action = read("src/renderer/app/actions/product.ts");
  const ipc = read("src/main/ipc/remote-product-ipc.ts");
  assert.match(action, /setStage\("review"\)/);
  assert.match(action, /setView\("workspace"\)/);
  const createTask = ipc.indexOf("db.createWorkflowTask(initialProduct.id, initialProduct.name)");
  const startAgent = ipc.indexOf("context.agentCore.send(initialProduct.id");
  assert.ok(createTask >= 0 && startAgent > createTask, "必须先建立任务中心记录，再启动 Agent");
  assert.doesNotMatch(ipc, /await runAutoConfirmedCreation/);
});

test("任务中心续跑只走 Agent，不再回退到已退役的一键调度器", () => {
  const ipc = read("src/main/ipc/remote-product-ipc.ts");
  const handler = ipc.slice(ipc.indexOf('ipcMain.handle("workflowTasks:resume"'), ipc.indexOf('ipcMain.handle("products:create"'));
  assert.match(handler, /context\.agentCore\.resume\(task\.localProductId\)/);
  assert.match(handler, /agentSnapshot\.run/);
  assert.match(handler, /context\.agentCore\.send\(/);
  assert.doesNotMatch(handler, /context\.resumeProductTask/);
  assert.match(handler, /mode === "from_start" && product\?\.productId/);
  assert.match(handler, /产品已进入 VBK 录入，不能从头重新规划/);
});

test("Agent 未终止时 products:get 保留本地规划工作集", () => {
  const ipc = read("src/main/ipc/remote-product-ipc.ts");
  assert.match(ipc, /agentCore\?\.get\(id\)/);
  assert.match(ipc, /!\["completed", "abandoned"\]\.includes\(agent\.run\.status\)/);
  assert.match(ipc, /agentOwnsLocalWorkingSet \? "planning" : context\.productWorkflows\.activeWorkflow\(id\)/);
  assert.match(ipc, /withAgentUsage\(await getProductForRead\([\s\S]*\), agent\)/);
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
