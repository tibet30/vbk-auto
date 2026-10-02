import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyHistoryResponse, shouldReplaceVisibleHistoryOnSnapshot } from "../../src/renderer/app/views/workspace/use-agent-session.js";

test("刷新快照不会把正在查看的旧历史跳回最新页", () => {
  assert.equal(shouldReplaceVisibleHistoryOnSnapshot(0), true);
  assert.equal(shouldReplaceVisibleHistoryOnSnapshot(1), false);
});

test("旧产品或较早分页响应不能覆盖当前历史窗口", () => {
  assert.equal(shouldApplyHistoryResponse("product-1", "product-1", 4, 4), true);
  assert.equal(shouldApplyHistoryResponse("product-1", "product-2", 4, 4), false);
  assert.equal(shouldApplyHistoryResponse("product-1", "product-1", 3, 4), false);
});
