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
    startPlanning: async () => { calls.push("planning"); },
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

test("一键生成仅在 readiness 通过后进入自动录入", async () => {
  const calls: string[] = [];
  await runAutoConfirmedCreation({
    startPlanning: async () => { calls.push("planning"); },
    readiness: () => ({ ready: true, completion: 100, issues: [] }),
    productWorkflows: {
      runExclusive: async (id, kind, task) => {
        calls.push(`${kind}:${id}`);
        return task();
      },
    },
    automation: { start: async (id) => { calls.push(`start:${id}`); } },
    db: {
      getProduct: () => undefined,
      addMessage: () => "message-1",
      updateProduct: () => makeProduct(),
    },
  }, "local-2");

  assert.deepEqual(calls, ["planning", "automation:local-2", "start:local-2"]);
});
