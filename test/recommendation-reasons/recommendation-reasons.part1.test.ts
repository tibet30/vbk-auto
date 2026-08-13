import {
  test,
  assert,
  recommendations,
  openRecommendationPage,
  recommendationState,
  buildRecommendationReasonsPlan,
  fillRecommendationReasons,
} from "./recommendation-reasons.shared.js";
test("3 项分类去重后顺序保留", () => {
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text: "B" },
    { category: "优选行程", text: "A" },
    { category: "缤纷景点", text: "C" },
  ]);
  assert.equal(plan.length, 3);
  assert.equal(plan[0]?.category, "精选酒店");
});

test("少于 3 项抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "优选行程", text: "A" },
  ]), /3 项/);
});

test("非白名单分类抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "超值套餐", text: "非法" },
    { category: "精选酒店", text: "B" },
    { category: "缤纷景点", text: "C" },
  ]), /白名单/);
});

test("重复分类抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "优选行程", text: "A" },
    { category: "优选行程", text: "B" },
    { category: "缤纷景点", text: "C" },
  ]), /重复/);
});

test("从一行开始逐组填写并通过 + 按钮生成三行", async () => {
  const page = await openRecommendationPage({ initialRows: 1, appendRows: true });
  try {
    await fillRecommendationReasons(page, recommendations);

    assert.deepEqual(await recommendationState(page), recommendations);
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("open:"))),
      ["open:0", "open:1", "open:2"],
    );
    // + 按钮被点了两次（从 1 行扩到 3 行）。
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("plus-click:"))),
      ["plus-click:0", "plus-click:1"],
    );
    assert.equal(
      await page.locator("#outside-decoy span.ant-select-selection-item").innerText(),
      "页面外下拉",
    );
    assert.equal(await page.locator("#outside-textarea").inputValue(), "页面外文本");
  } finally {
    await page.close();
  }
});

test("已有三行随机内容时仍逐行重选分类并覆盖文本", async () => {
  const page = await openRecommendationPage({ initialRows: 3 });
  try {
    await fillRecommendationReasons(page, recommendations);

    assert.deepEqual(await recommendationState(page), recommendations);
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("select:"))),
      recommendations.map((item, index) => `select:${index}:${item.category}`),
    );
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("fill:"))),
      recommendations.map((item, index) => `fill:${index}:${item.text}`),
    );
    // 已满 3 行不应触发任何 + 按钮。
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("plus-click:"))),
      [],
    );
  } finally {
    await page.close();
  }
});

for (const [control, description] of [
  ["label", "label[title=推荐理由]"],
  ["combobox", "div.ant-select"],
  ["textarea", "textarea.ant-input"],
] as const) {
  test(`每行 ${description} 必须恰好一个`, async () => {
    const page = await openRecommendationPage({ initialRows: 1, appendRows: true, duplicateControl: control });
    try {
      await assert.rejects(
        fillRecommendationReasons(page, recommendations),
        new RegExp(`第 1 组推荐理由.*数量异常：期望 1，实际 2`),
      );
    } finally {
      await page.close();
    }
  });
}

test("推荐理由区域必须严格唯一", async () => {
  const page = await openRecommendationPage({ initialRows: 1, appendRows: true, duplicateSection: true });
  try {
    await assert.rejects(
      fillRecommendationReasons(page, recommendations),
      /推荐理由区域数量异常：期望 1，实际 2/,
    );
  } finally {
    await page.close();
  }
});

test("页面无 + 按钮且行数不足时抛出明确错误", async () => {
  // initialRows: 1 且不传 appendRows → fixture 不渲染 + 按钮，
  // 模拟「页面应该出现新行但没渲染 +」的 VBK 异常情况。
  const page = await openRecommendationPage({ initialRows: 1 });
  try {
    await assert.rejects(
      fillRecommendationReasons(page, recommendations),
      /推荐理由最后一行缺少 \+ 按钮/,
    );
    // row 0 还没开始填就被 grow 阶段阻断，状态应保持初始空。
    const state = await recommendationState(page);
    assert.equal(state.length, 1);
    assert.equal(state[0]?.category, "");
    assert.equal(state[0]?.text, "");
  } finally {
    await page.close();
  }
});

test("异步延迟生成下一行与子控件也能稳定完成", async () => {
  const page = await openRecommendationPage({
    initialRows: 1,
    appendRows: true,
    appendDelayMs: 200,
  });
  try {
    await fillRecommendationReasons(page, recommendations);
    assert.deepEqual(await recommendationState(page), recommendations);
    // + 按钮点击顺序也应被忠实记录。
    assert.deepEqual(
      await page.evaluate(() => window.recommendationEvents.filter((event) => event.startsWith("plus-click:"))),
      ["plus-click:0", "plus-click:1"],
    );
  } finally {
    await page.close();
  }
});
