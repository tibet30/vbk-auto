import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function approvedSnapshot(id: string, uncertain = false): AgentSnapshot {
  return {
    localProductId: id,
    run: { id: "approved-run", status: "waiting_approval", intentVersion: "old-intent", createdAt: "now", updatedAt: "now" },
    pendingApproval: {
      id: "approval", accountKey: "account", productVersion: "version", intentVersion: "old-intent",
      scope: ["vbk.write_phase:basic"], summary: "旧方案录入", status: "pending", createdAt: "now",
    },
    ...(uncertain ? { uncertainWrite: { toolCallId: "write", message: "等待权威回读", createdAt: "now" } } : {}),
    events: [{
      id: "approved", runId: "approved-run", type: "approval", content: "已批准", createdAt: "now",
      data: { approval: { id: "approval", accountKey: "account", productVersion: "version", intentVersion: "old-intent", scope: ["vbk.write_phase:basic"], summary: "旧方案录入", status: "approved", createdAt: "now" } },
    }],
  };
}

function productWithFailedAutomation() {
  const product = buildProductSnapshot({ destination: "日喀则", days: 1, productForm: "privateTour" });
  product.productId = "vbk-existing-product";
  product.automation = { id: "automation", status: "failed", phases: [], logs: [] };
  return product;
}

test("SQLite 中旧审批自动化失败后，本地修改隔离为新运行且不交接远端", async () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "vbk-approved-isolation-"));
  const db = new VbkDatabase(dataPath);
  try {
    const product = productWithFailedAutomation();
    db.importProductSnapshot(product);
    db.saveAgentSnapshot(approvedSnapshot(product.id));
    let handoffs = 0;
    const core = new AgentCore({
      model: { complete: async () => ({ content: "已记录新的本地行程修改。" }) }, tools: [],
      accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
      preparationProduct: (id) => db.getProduct(id),
      handoffApprovedWorkflow: () => { handoffs += 1; return true; },
      id: (() => { let n = 0; return () => `new-${++n}`; })(),
    }, db);

    await core.send(product.id, "把第1天的景点调整为运营确认后的顺序");
    await core.idle(product.id);
    const next = db.getAgentSnapshot(product.id)!;
    assert.notEqual(next.run?.id, "approved-run");
    assert.equal(next.events.some((event) => event.runId === next.run?.id && event.type === "approval"), false);
    assert.equal(next.events.some((event) => event.runId === next.run?.id && event.data?.remoteWrite === true), false);
    assert.equal(next.events.some((event) => event.runId === next.run?.id && event.data?.isolatedFromApprovedRun === true), true);
    assert.equal(handoffs, 0);
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
});

test("不确定写入未核对时，本地修改仍暂停且不丢失旧边界", async () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "vbk-approved-uncertain-"));
  const db = new VbkDatabase(dataPath);
  try {
    const product = productWithFailedAutomation();
    db.importProductSnapshot(product);
    db.saveAgentSnapshot(approvedSnapshot(product.id, true));
    let handoffs = 0;
    const core = new AgentCore({
      model: { complete: async () => ({ content: "不应调用模型" }) }, tools: [],
      accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
      preparationProduct: (id) => db.getProduct(id),
      handoffApprovedWorkflow: () => { handoffs += 1; return true; },
    }, db);

    const next = await core.send(product.id, "修改第1天景点安排");
    assert.equal(next.run?.id, "approved-run");
    assert.equal(next.run?.status, "paused");
    assert.equal(next.uncertainWrite?.toolCallId, "write");
    assert.equal(handoffs, 0);
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
});
