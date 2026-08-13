/**
 * product-list-helper 纯函数测试。
 *
 * 覆盖 onProductUpdated 回调中 setProducts 的列表更新逻辑：
 *   - 列表中已有该 id → 替换并移到首位
 *   - 列表中不存在该 id → 原样返回，不插入迟到/已删除的项
 *   - 空列表 → 原样返回
 */

import test from "node:test";
import assert from "node:assert/strict";
import { upsertProductToTop } from "../../src/renderer/app/state/product-list-helper.js";
import type { ProductSummary } from "../../src/shared/contracts-types.js";

function makeProduct(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: "a0000000-0000-0000-0000-000000000001",
    name: "默认产品",
    status: "planning",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 替换置顶
// ──────────────────────────────────────────────────────────────────────────

test("列表中已有该 id（中间位置）→ 替换并移到首位", () => {
  const a = makeProduct({ id: "a", name: "A" });
  const b = makeProduct({ id: "b", name: "B" });
  const c = makeProduct({ id: "c", name: "C" });
  const updatedB = makeProduct({ id: "b", name: "B-updated", status: "review" });

  const result = upsertProductToTop([a, b, c], updatedB);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, "b");
  assert.equal(result[0].name, "B-updated");
  assert.equal(result[0].status, "review");
  assert.equal(result[1].id, "a");
  assert.equal(result[2].id, "c");
});

test("列表中已有该 id（已在首位）→ 替换并保持首位", () => {
  const a = makeProduct({ id: "a", name: "A" });
  const b = makeProduct({ id: "b", name: "B" });
  const updatedA = makeProduct({ id: "a", name: "A-updated" });

  const result = upsertProductToTop([a, b], updatedA);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "a");
  assert.equal(result[0].name, "A-updated");
  assert.equal(result[1].id, "b");
});

test("列表中已有该 id（末尾）→ 替换并移到首位", () => {
  const a = makeProduct({ id: "a", name: "A" });
  const b = makeProduct({ id: "b", name: "B" });
  const updatedB = makeProduct({ id: "b", name: "B-updated" });

  const result = upsertProductToTop([a, b], updatedB);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "b");
  assert.equal(result[0].name, "B-updated");
  assert.equal(result[1].id, "a");
});

// ──────────────────────────────────────────────────────────────────────────
// 不存在不插入（迟到事件/已删除项的安全网）
// ──────────────────────────────────────────────────────────────────────────

test("列表中不存在该 id → 原样返回，不插入", () => {
  const a = makeProduct({ id: "a", name: "A" });
  const b = makeProduct({ id: "b", name: "B" });
  const list = [a, b];
  const unknown = makeProduct({ id: "deleted", name: "已删除的产品" });

  const result = upsertProductToTop(list, unknown);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "a");
  assert.equal(result[1].id, "b");
  // 确保返回的是同一个引用（完全没动）
  assert.strictEqual(result, list);
});

test("空列表 + 任意 product → 原样返回空数组", () => {
  const unknown = makeProduct({ id: "x" });
  const result = upsertProductToTop([], unknown);
  assert.equal(result.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// 回调接线：模拟 onProductUpdated list -> setProducts 的行为不变量
// ──────────────────────────────────────────────────────────────────────────

test("模拟 onProductUpdated 回调：产品在列表中时 setProducts 正确更新", () => {
  // 模拟 setProducts(prev => upsertProductToTop(prev, next)) 的行为。
  const originalList: ProductSummary[] = [
    makeProduct({ id: "p1", name: "产品一" }),
    makeProduct({ id: "p2", name: "产品二" }),
  ];
  const updated: ProductSummary = makeProduct({ id: "p2", name: "产品二（已更新）", status: "review" });

  const newList = upsertProductToTop(originalList, updated);
  assert.equal(newList.length, 2);
  assert.equal(newList[0].id, "p2");
  assert.equal(newList[0].name, "产品二（已更新）");
  assert.equal(newList[0].status, "review");
  assert.equal(newList[1].id, "p1");
});

test("模拟 onProductUpdated 回调：产品已不在列表中时不插入", () => {
  // 迟到事件：产品已被删除，但 onProductUpdated 仍收到事件。
  const originalList: ProductSummary[] = [
    makeProduct({ id: "p1", name: "产品一" }),
  ];
  const stale: ProductSummary = makeProduct({ id: "deleted-p2", name: "已删除" });

  const newList = upsertProductToTop(originalList, stale);
  assert.equal(newList.length, 1);
  assert.equal(newList[0].id, "p1");
});
