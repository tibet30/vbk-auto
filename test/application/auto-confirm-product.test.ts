import assert from "node:assert/strict";
import test from "node:test";
import { runAutoConfirmedCreation } from "../../src/main/application/auto-confirm-product.js";

function makeProduct() {
  return {
    id: "local-1",
    name: "太原2天1晚私家团",
    status: "review",
    updatedAt: "2026-08-30T00:00:00.000Z",
    product: {},
    messages: [],
    researchTasks: [],
  } as never;
}

test("一键生成在 readiness 未通过时保留待确认项且不写入 VBK", async () => {
  const calls: string[] = [];
  const product = makeProduct();
  await runAutoConfirmedCreation({
    startPlanning: async () => {
      calls.push("planning");
      return { status: "completed", rejected: [], assistantReply: "规划完成" } as never;
    },
    readiness: () => ({ ready: false, completion: 80, issues: [{ label: "封面图", detail: "缺少图片" }] }),
    productWorkflows: { runExclusive: async (_id, _kind, task) => task() },
    automation: { start: async () => { calls.push("automation"); } },
    db: {
      getProduct: () => product,
      addMessage: (_id, _role, message) => { calls.push(message); return "message-1"; },
      updateProduct: (_id, _product, status) => { calls.push(status); return product; },
    },
  }, product.id);

  assert.deepEqual(calls, ["planning", "自动生成完成，但仍有待确认项：封面图。未开始录入携程。", "blocked"]);
});

test("一键生成在规划未完成时保留真实规划原因，不伪造字段缺失失败", async () => {
  const calls: string[] = [];
  const product = makeProduct();
  await runAutoConfirmedCreation({
    startPlanning: async () => ({
      status: "needs_user",
      rejected: [{ module: "researchTasks", reason: "POI 地域不匹配（河北/张家口）" }],
      assistantReply: "规划已暂停",
    } as never),
    readiness: () => {
      calls.push("readiness");
      return { ready: false, completion: 0, issues: [] };
    },
    productWorkflows: { runExclusive: async (_id, _kind, task) => task() },
    automation: { start: async () => { calls.push("automation"); } },
    db: {
      getProduct: () => product,
      addMessage: (_id, _role, message) => { calls.push(message); return "message-1"; },
      updateProduct: () => { calls.push("update"); return product; },
    },
  }, product.id);

  assert.deepEqual(calls, ["一键录入暂停：规划尚未完成。POI 地域不匹配（河北/张家口）。已保留当前规划进度，解决该节点后会从此处续跑。"]);
});

test("一键生成仅在 readiness 通过后进入自动录入", async () => {
  const calls: string[] = [];
  await runAutoConfirmedCreation({
    startPlanning: async () => {
      calls.push("planning");
      return { status: "completed", rejected: [], assistantReply: "规划完成" } as never;
    },
    readiness: () => ({ ready: true, completion: 100, issues: [] }),
    productWorkflows: {
      runExclusive: async (id, kind, task) => {
        calls.push(`${kind}:${id}`);
        return task();
      },
    },
    automation: { start: async (id) => { calls.push(`start:${id}`); } },
    db: {
      getProduct: () => ({
        ...makeProduct(),
        status: "draft_saved",
        automation: { id: "run-1", status: "succeeded", phases: [], logs: [] },
      } as never),
      addMessage: () => "message-1",
      updateProduct: () => makeProduct(),
    },
  }, "local-2");

  assert.deepEqual(calls, ["planning", "automation:local-2", "start:local-2"]);
});

test("自动录入返回 failed 时一键任务必须需要处理，不能误报完成", async () => {
  const failedProduct = {
    ...makeProduct(),
    status: "blocked",
    automation: {
      id: "run-failed",
      status: "failed",
      phases: [{ phase: "presentation", status: "failed" }],
      logs: [{ at: new Date().toISOString(), level: "warning", message: "phase=presentation attempt=1 failed" }],
      recovery: {
        phases: {
          presentation: {
            phase: "presentation",
            state: "needs_user",
            attempts: [],
            finalError: "产品图文接口保存失败：非法关键词：首选",
          },
        },
      },
    },
  } as never;
  const result = await runAutoConfirmedCreation({
    startPlanning: async () => ({ status: "completed", rejected: [], assistantReply: "完成" }) as never,
    readiness: () => ({ ready: true, completion: 100, issues: [] }),
    productWorkflows: { runExclusive: async (_id, _kind, task) => task() },
    automation: { start: async () => undefined },
    db: {
      getProduct: () => failedProduct,
      addMessage: () => "message-1",
      updateProduct: () => failedProduct,
    },
  }, "local-failed");

  assert.deepEqual(result, {
    status: "needs_attention",
    stage: "automation",
    message: "产品图文接口保存失败：非法关键词：首选",
  });
});
