import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { MemoryService } from "../../src/main/memory/memory-service.js";

function tempDb() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-memory-"));
  return { dataPath, db: new VbkDatabase(dataPath) };
}

test("显式记忆写入 SQLite 后默认按登录用户全局读回", () => {
  const { dataPath, db } = tempDb();
  try {
    const service = new MemoryService({ db, getOwnerUserId: () => 1001 });
    const product = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
    const saved = service.captureExplicitFromUserMessage("记住以后酒店默认用当地 5 钻", {
      localProductId: product.id,
      sourceKind: "agent:user",
    });

    assert.ok(saved);
    assert.equal(saved.memory.ownerUserId, 1001);
    assert.equal(saved.memory.scopeType, "global");
    assert.equal(saved.memory.scopeKey, "global");
    assert.equal(saved.memory.topic, "hotel");

    const listed = service.list({ scopeType: "global", scopeKey: "global" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].content, "以后酒店默认用当地 5 钻");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("明确限定当前产品的记忆保存到产品范围", () => {
  const { dataPath, db } = tempDb();
  try {
    const service = new MemoryService({ db, getOwnerUserId: () => 1001 });
    const product = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
    const saved = service.captureExplicitFromUserMessage("记住这个产品用轻松慢节奏", {
      localProductId: product.id,
      sourceKind: "agent:user",
    });

    assert.ok(saved);
    assert.equal(saved.memory.scopeType, "product");
    assert.equal(saved.memory.scopeKey, product.id);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("不同用户之间记忆隔离，未登录时拒绝写入", () => {
  const { dataPath, db } = tempDb();
  try {
    const userA = new MemoryService({ db, getOwnerUserId: () => 1001 });
    const userB = new MemoryService({ db, getOwnerUserId: () => 1002 });
    userA.saveExplicit({ topic: "workflow", content: "提交前先跑完整检查" });

    assert.equal(userA.list({ scopeType: "global", scopeKey: "global" }).length, 1);
    assert.equal(userB.list({ scopeType: "global", scopeKey: "global" }).length, 0);

    const anonymous = new MemoryService({ db, getOwnerUserId: () => null });
    assert.throws(() => anonymous.saveExplicit({ topic: "general", content: "偏好中文输出" }), /请先登录/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("未登录时显式捕获软失败，不抛错阻断主对话", () => {
  const { dataPath, db } = tempDb();
  try {
    const anonymous = new MemoryService({ db, getOwnerUserId: () => null });
    assert.equal(
      anonymous.captureExplicitFromUserMessage("记住以后酒店默认用当地 5 钻", { sourceKind: "agent:user" }),
      undefined,
    );
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("记忆维护状态部分更新不会覆盖未提交字段", () => {
  const { dataPath, db } = tempDb();
  try {
    const service = new MemoryService({ db, getOwnerUserId: () => 1001 });
    service.settings({ autoCapture: false });
    db.createOrUpdateMemoryState(1001, { pending_count: 3 });

    const afterScopeOnly = service.settings({ scopeKey: "product-1" });
    assert.equal(afterScopeOnly.autoCapture, false, "只改 scopeKey 不能把 autoCapture 重置为 true");
    assert.equal(afterScopeOnly.pendingCount, 3, "只改 scopeKey 不能清空 pendingCount");
    assert.equal(afterScopeOnly.scopeKey, "product-1");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("上下文注入按条数和预算裁剪", () => {
  const { dataPath, db } = tempDb();
  try {
    const service = new MemoryService({ db, getOwnerUserId: () => 1001 });
    for (let index = 0; index < 12; index += 1) {
      service.saveExplicit({
        topic: "copywriting",
        content: `长期文案偏好 ${index}：保持克制和可核查`,
      });
    }

    const context = service.loadContextMemories({ maxItems: 8, maxTokens: 800 });
    assert.equal(context.lines.length, 8);
    assert.equal(context.maxItems, 8);
    assert.ok(context.skipped >= 4);
    assert.ok(context.budgets.usedTokens <= context.budgets.budgetTokens);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("全新库首次读取维护状态会落地默认行（scheduleMemoryMaintenance 首轮路径）", () => {
  const { dataPath, db } = tempDb();
  try {
    const service = new MemoryService({ db, getOwnerUserId: () => 1001 });
    // main-runtime.scheduleMemoryMaintenance 的首轮就是无参 settings()，
    // 此时 memory_maintenance_state 还没有该 owner 的行。
    const state = service.settings();
    assert.equal(state.ownerUserId, 1001);
    assert.equal(state.autoCapture, true);
    assert.equal(state.pendingCount, 0);
    assert.equal(state.lastSuccessAt, null);

    // 独立连接回读，确认默认行真的写入了 SQLite，而不是只返回 fallback。
    const raw = new Database(path.join(dataPath, "vbk-desktop.sqlite"), { readonly: true });
    try {
      const row = raw
        .prepare("SELECT owner_user_id, auto_capture, pending_count FROM memory_maintenance_state WHERE owner_user_id=?")
        .get(1001) as { owner_user_id: number; auto_capture: number; pending_count: number } | undefined;
      assert.ok(row, "首次读取后必须存在维护状态行");
      assert.equal(row.owner_user_id, 1001);
      assert.equal(row.auto_capture, 1);
      assert.equal(row.pending_count, 0);
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
