import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVbkSubtitle, vbkTextLength } from "../../src/main/automation/ctrip/basic-info/core.js";

test("VBK 副标题按中文双宽计数并保持在 80 以内", () => {
  const normalized = normalizeVbkSubtitle("西安古都文化精华2日跟团游", "西安");
  assert.ok(vbkTextLength(normalized) >= 30);
  assert.ok(vbkTextLength(normalized) <= 80);
});

test("已足够长的中英文副标题也按 VBK 计数截断", () => {
  const normalized = normalizeVbkSubtitle("西安文化体验".repeat(10), "西安");
  assert.equal(vbkTextLength(normalized), 80);
});
