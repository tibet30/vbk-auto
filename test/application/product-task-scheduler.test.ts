import assert from "node:assert/strict";
import test from "node:test";
import { ProductTaskScheduler } from "../../src/main/application/product-task-scheduler.js";
import type { ProductDetail, ProductWorkflowTask } from "../../src/shared/contracts.js";

function product(): ProductDetail {
  return {
    id: "local-task-product",
    name: "丽江6天5晚私家团",
    status: "planning",
    updatedAt: new Date().toISOString(),
    product: {},
    messages: [],
    researchTasks: [],
  };
}

function fakeTaskStore() {
  let task: ProductWorkflowTask | undefined;
  return {
    createWorkflowTask(localProductId: string, productName: string) {
      task = {
        id: "task-1", localProductId, productName, status: "queued", stage: "queued",
        progress: 0, message: "任务已创建，等待开始", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      return task;
    },
    getWorkflowTask: () => task,
    listWorkflowTasks: () => task ? [task] : [],
    abandonWorkflowTask() {
      task = {
        ...task!, status: "abandoned", message: "任务已永久废弃", error: undefined,
        completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      return task;
    },
    updateWorkflowTask(_id: string, patch: Partial<ProductWorkflowTask>) {
      task = { ...task!, ...patch, updatedAt: new Date().toISOString() };
      return task;
    },
    getProduct: () => ({
      ...product(),
      status: "draft_saved",
      automation: { id: "run-1", status: "succeeded", phases: [], logs: [] },
    }),
    addMessage: () => "message-1",
    updateProduct: () => undefined,
  };
}

test("enqueue 立即返回 queued，后台依次推进规划、核验、录入并完成", async () => {
  const store = fakeTaskStore();
  const stages: string[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const scheduler = new ProductTaskScheduler({
    db: store as never,
    startPlanning: async () => ({ status: "completed", rejected: [], assistantReply: "完成" }) as never,
    readiness: () => ({ ready: true, completion: 100, issues: [] }),
    productWorkflows: { runExclusive: async (_id, _kind, work) => work() },
    automation: { start: async () => { stages.push("automation-called"); } },
    emitTask: (task) => {
      stages.push(`${task.stage}:${task.status}`);
      if (task.status === "succeeded") resolveDone();
    },
    emitProduct: () => undefined,
  });

  const queued = scheduler.enqueue(product());
  assert.equal(queued.status, "queued", "创建调用栈内不能等待后台长流程");
  await done;

  assert.deepEqual(stages, [
    "queued:queued",
    "planning:running",
    "planning:running",
    "readiness:running",
    "automation:running",
    "automation-called",
    "completed:succeeded",
  ]);
});

test("readiness 未通过时任务保留为 needs_attention，不调用携程自动录入", async () => {
  const store = fakeTaskStore();
  let automationCalls = 0;
  let resolveDone!: (task: ProductWorkflowTask) => void;
  const done = new Promise<ProductWorkflowTask>((resolve) => { resolveDone = resolve; });
  const scheduler = new ProductTaskScheduler({
    db: store as never,
    startPlanning: async () => ({ status: "completed", rejected: [], assistantReply: "完成" }) as never,
    readiness: () => ({ ready: false, completion: 90, issues: [{ label: "封面", detail: "缺少封面" }] }),
    productWorkflows: { runExclusive: async (_id, _kind, work) => work() },
    automation: { start: async () => { automationCalls += 1; } },
    emitTask: (task) => { if (task.status === "needs_attention") resolveDone(task); },
    emitProduct: () => undefined,
  });

  scheduler.enqueue(product());
  const terminal = await done;
  assert.equal(terminal.stage, "readiness");
  assert.equal(terminal.status, "needs_attention");
  assert.equal(automationCalls, 0);
});

test("排队任务永久废弃后不会启动规划，重复废弃保持终态", async () => {
  const store = fakeTaskStore();
  let planningCalls = 0;
  const scheduler = new ProductTaskScheduler({
    db: store as never,
    startPlanning: async () => { planningCalls += 1; return { status: "completed", rejected: [], assistantReply: "完成" } as never; },
    readiness: () => ({ ready: true, completion: 100, issues: [] }),
    productWorkflows: { runExclusive: async (_id, _kind, work) => work() },
    automation: { start: async () => undefined },
    emitTask: () => undefined,
    emitProduct: () => undefined,
  });

  const queued = scheduler.enqueue(product());
  const abandoned = await scheduler.abandon(queued.id);
  const repeated = await scheduler.abandon(queued.id);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(abandoned.status, "abandoned");
  assert.equal(repeated.updatedAt, abandoned.updatedAt);
  assert.equal(planningCalls, 0);
  assert.equal(store.getWorkflowTask()?.status, "abandoned");
});

test("规划中永久废弃会保留当前请求结果，但不再进入核验或携程录入", async () => {
  const store = fakeTaskStore();
  let releasePlanning!: () => void;
  const planningGate = new Promise<void>((resolve) => { releasePlanning = resolve; });
  let automationCalls = 0;
  let resolvePlanningStarted!: () => void;
  const planningStarted = new Promise<void>((resolve) => { resolvePlanningStarted = resolve; });
  const scheduler = new ProductTaskScheduler({
    db: store as never,
    startPlanning: async () => {
      resolvePlanningStarted();
      await planningGate;
      return { status: "completed", rejected: [], assistantReply: "完成" } as never;
    },
    readiness: () => { throw new Error("废弃后不应进入 readiness"); },
    productWorkflows: { runExclusive: async (_id, _kind, work) => work() },
    automation: { start: async () => { automationCalls += 1; } },
    emitTask: () => undefined,
    emitProduct: () => undefined,
  });

  const queued = scheduler.enqueue(product());
  await planningStarted;
  await scheduler.abandon(queued.id);
  releasePlanning();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(store.getWorkflowTask()?.status, "abandoned");
  assert.equal(automationCalls, 0);
});

test("携程录入中永久废弃会请求安全停止且迟到结果不能覆盖废弃终态", async () => {
  const store = fakeTaskStore();
  let releaseAutomation!: () => void;
  const automationGate = new Promise<void>((resolve) => { releaseAutomation = resolve; });
  let resolveAutomationStarted!: () => void;
  const automationStarted = new Promise<void>((resolve) => { resolveAutomationStarted = resolve; });
  let stopCalls = 0;
  const scheduler = new ProductTaskScheduler({
    db: store as never,
    startPlanning: async () => ({ status: "completed", rejected: [], assistantReply: "完成" }) as never,
    readiness: () => ({ ready: true, completion: 100, issues: [] }),
    productWorkflows: { runExclusive: async (_id, _kind, work) => work() },
    automation: {
      start: async () => { resolveAutomationStarted(); await automationGate; },
      stop: async () => { stopCalls += 1; releaseAutomation(); },
    },
    emitTask: () => undefined,
    emitProduct: () => undefined,
  });

  const queued = scheduler.enqueue(product());
  await automationStarted;
  await scheduler.abandon(queued.id);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopCalls, 1);
  assert.equal(store.getWorkflowTask()?.status, "abandoned");
});
