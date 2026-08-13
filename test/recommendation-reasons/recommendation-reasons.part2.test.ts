import {
  test,
  assert,
  recommendations,
  openRecommendationPage,
  recommendationState,
  fillRecommendationReasons,
  RECOMMENDATION_CATEGORIES,
} from "./recommendation-reasons.shared.js";

test("仅有禁用同名项时拒绝选择并给出明确错误", async () => {
  const page = await openRecommendationPage({
    initialRows: 1,
    appendRows: true,
    disableRecommendationCategories: [...RECOMMENDATION_CATEGORIES],
  });
  try {
    await assert.rejects(
      fillRecommendationReasons(page, recommendations),
      /第 1 组推荐理由没有可用的精确选项「优选行程」/,
    );
  } finally {
    await page.close();
  }
});

test("已有目标类别时跳过下拉但仍覆盖文本", async () => {
  const page = await openRecommendationPage({
    initialRows: 3,
    initialCategories: ["优选行程", "旧分类1", "旧分类2"],
  });
  try {
    await fillRecommendationReasons(page, recommendations);
    assert.deepEqual(await recommendationState(page), recommendations);
    const opens = await page.evaluate(() =>
      window.recommendationEvents.filter((event) => event.startsWith("open:")),
    );
    assert.deepEqual(opens, ["open:1", "open:2"]);
    assert.deepEqual(
      await page.evaluate(() =>
        window.recommendationEvents
          .filter((event) => event.startsWith("select:"))
          .map((event) => String(event).split(":").slice(1).join(":")),
      ),
      ["1:精选酒店", "2:缤纷景点"],
    );
  } finally {
    await page.close();
  }
});

test("已有随机类别仍走下拉覆盖", async () => {
  const page = await openRecommendationPage({ initialRows: 3 });
  try {
    await fillRecommendationReasons(page, recommendations);
    assert.deepEqual(await recommendationState(page), recommendations);
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("open:"))),
      ["open:0", "open:1", "open:2"],
    );
  } finally {
    await page.close();
  }
});
