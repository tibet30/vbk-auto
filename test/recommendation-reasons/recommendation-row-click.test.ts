import test from "node:test";
import assert from "node:assert/strict";
import { appendRecommendationRow } from "../../src/main/automation/ctrip/presentation/recommendations.js";

test("追加推荐理由使用 Playwright 真实点击并等待新行", async () => {
  let clicked = 0;
  let waitedForTarget = 0;
  const page = {
    locator(selector: string) {
      assert.equal(selector, "#pm_recommend .ant-form-item");
      return {
        count: async () => 1,
        last: () => ({
          locator: () => ({
            count: async () => 1,
            last: () => ({ click: async () => { clicked += 1; } }),
          }),
        }),
      };
    },
    waitForFunction: async (_fn: unknown, target: number) => {
      waitedForTarget = target;
    },
  };

  await appendRecommendationRow(page, 1);

  assert.equal(clicked, 1);
  assert.equal(waitedForTarget, 2);
});
