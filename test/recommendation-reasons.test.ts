import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  buildRecommendationReasonsPlan,
  fillRecommendationReasons,
} from "../src/main/automation/ctrip.js";
import { RECOMMENDATION_CATEGORIES } from "../src/main/automation/schema.js";

const recommendations = [
  { category: "优选行程", text: "行程安排合理" },
  { category: "精选酒店", text: "精选舒适酒店" },
  { category: "缤纷景点", text: "覆盖代表性景点" },
];

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

type RecommendationPageConfig = {
  initialRows: number;
  initialCategories?: string[];
  appendRows?: boolean;
  appendDelayMs?: number;
  duplicateControl?: "label" | "combobox" | "textarea";
  duplicateSection?: boolean;
  disableRecommendationCategories?: string[];
};

async function openRecommendationPage(config: RecommendationPageConfig) {
  const page = await browser.newPage();
  const dropdownHtml = `
    <div class="ant-select-dropdown ant-select-dropdown-hidden">
      <div role="option" class="ant-select-item-option">优选行程扩展</div>
      ${RECOMMENDATION_CATEGORIES.map((category) => {
        const disabled = config.disableRecommendationCategories?.includes(category);
        const cls = disabled
          ? "ant-select-item-option ant-select-item-option-disabled ant-select-dropdown-menu-item-disabled"
          : "ant-select-item-option";
        const attrs = disabled ? " aria-disabled=\"true\"" : "";
        return `<div role="option" class="${cls}"${attrs}>${category}</div>`;
      }).join("")}
    </div>
  `;
  await page.setContent(`
    <style>.ant-select-dropdown-hidden { display: none; }</style>
    <div id="outside-decoy" class="ant-form-item">
      <label title="推荐理由">推荐理由</label>
      <div class="ant-select" style="display:inline-block">
        <div class="ant-select-selector">
          <span class="ant-select-selection-search">
            <input id="outside-combobox" class="ant-select-selection-search-input" role="combobox" />
          </span>
          <span class="ant-select-selection-item">页面外下拉</span>
        </div>
      </div>
      <textarea id="outside-textarea" class="ant-input" placeholder="推荐理由">页面外文本</textarea>
    </div>
    <section id="pm_recommend"></section>
    ${config.duplicateSection ? '<section id="pm_recommend"></section>' : ""}
    ${dropdownHtml}
    <script>
      (() => {
        const config = ${JSON.stringify(config)};
        const section = document.querySelector("#pm_recommend");
        const dropdown = document.querySelector(".ant-select-dropdown");
        const events = [];
        let activeRow = null;
        window.recommendationEvents = events;

        // 真实 VBK：每行末尾的 +/− 按钮都用 span.anticon + 内联 color:#1658DC，
        // 顺序固定「− 在前、+ 在后」。fillRecommendationReasons 只看「最后一
        // 行的最后一个蓝图标」并视为 +。本 fixture 在 appendRows=true 时按
        // index 给每行渲染 −（仅当 index≥1）和 +，与真实 VBK 视觉一致；代码
        // 只点末行末尾的 +，多出来的 + 是 no-op。
        const MINUS_SVG =
          '<svg width="1em" height="1em" viewBox="0 0 1024 1024"><path d="M213.333 469.333L810.667 469.333C822.449 469.333 832 478.885 832 490.667L832 533.333C832 545.115 822.449 554.667 810.667 554.667L213.333 554.667C201.551 554.667 192 545.115 192 533.333L192 490.667C192 478.885 201.551 469.333 213.333 469.333z" fill="currentColor"></path></svg>';
        const PLUS_SVG =
          '<svg width="1em" height="1em" viewBox="0 0 1024 1024"><path d="M533.333 832C544.274 832 553.291 823.764 554.523 813.155L554.667 810.667L554.667 554.667L810.667 554.667C821.607 554.667 830.624 546.431 831.856 535.821L832 533.333L832 490.667C832 479.726 823.764 470.709 813.155 469.477L810.667 469.333L554.667 469.333L554.667 213.333C554.667 202.393 546.431 193.376 535.821 192.144L533.333 192L490.667 192C479.726 192 470.709 200.236 469.477 210.845L469.333 213.333L469.333 469.333L213.333 469.333C202.393 469.333 193.376 477.569 192.144 488.179L192 490.667L192 533.333C192 544.274 200.236 553.291 210.845 554.523L213.333 554.667L469.333 469.333L469.333 810.667C469.333 821.607 477.569 830.624 488.179 831.856L490.667 832L533.333 832z" fill="currentColor"></path></svg>';
        const ICON_STYLE = "font-size:19px;color:rgb(22, 88, 220);margin-top:1px";

        function buildSelectHtml(extraSelects) {
          const parts = [
            '<div class="ant-select" style="display:inline-block">',
            '  <div class="ant-select-selector">',
            '    <span class="ant-select-selection-search">',
            '      <input class="ant-select-selection-search-input" role="combobox" />',
            '    </span>',
            '    <span class="ant-select-selection-item"></span>',
            '  </div>',
            '</div>',
          ];
          for (let i = 0; i < extraSelects; i += 1) {
            parts.push('<div class="ant-select" style="display:inline-block"><div class="ant-select-selector"><span class="ant-select-selection-search"><input class="ant-select-selection-search-input" role="combobox" /></span><span class="ant-select-selection-item"></span></div></div>');
          }
          return parts.join("");
        }

        function appendRow(category, text) {
          const index = section.querySelectorAll(".ant-form-item").length;
          const row = document.createElement("div");
          row.className = "ant-form-item";
          row.dataset.index = String(index);
          let extraSelects = 0;
          if (index === 0 && config.duplicateControl === "combobox") extraSelects = 1;
          const icons = [];
          // 真实 VBK：第一行没有 −；这里只在 index≥1 时渲染。
          if (index >= 1) {
            icons.push(\`<span role="img" tabindex="-1" class="anticon" data-action="minus" style="\${ICON_STYLE}">\${MINUS_SVG}</span>\`);
          }
          if (config.appendRows) {
            icons.push(\`<span role="img" tabindex="-1" class="anticon" data-action="plus" style="\${ICON_STYLE}">\${PLUS_SVG}</span>\`);
          }
          row.innerHTML = [
            '<label title="推荐理由">推荐理由</label>',
            buildSelectHtml(extraSelects),
            '<textarea class="ant-input">' + text + "</textarea>",
            icons.join(""),
          ].join("");

          if (index === 0 && config.duplicateControl === "label") {
            row.insertAdjacentHTML("beforeend", '<label title="推荐理由">推荐理由</label>');
          }
          if (index === 0 && config.duplicateControl === "textarea") {
            row.insertAdjacentHTML("beforeend", '<textarea class="ant-input">重复文本</textarea>');
          }

          const selector = row.querySelector("div.ant-select-selector");
          const selectionItem = row.querySelector("span.ant-select-selection-item");
          if (category) {
            selectionItem.textContent = category;
            selectionItem.dataset.value = category;
          } else {
            selectionItem.textContent = "";
            selectionItem.dataset.value = "";
          }
          const textarea = row.querySelector("textarea.ant-input");
          selector.addEventListener("click", () => {
            activeRow = row;
            events.push("open:" + index);
            dropdown.classList.remove("ant-select-dropdown-hidden");
          });
          textarea.addEventListener("input", () => {
            events.push("fill:" + index + ":" + textarea.value);
          });
          // + 按钮的点击事件：模拟真实 VBK 异步追加。
          const plusBtn = row.querySelector('span.anticon[data-action="plus"]');
          if (plusBtn) {
            plusBtn.addEventListener("click", () => {
              events.push("plus-click:" + index);
              const append = () => appendRow("", "");
              if (config.appendDelayMs && config.appendDelayMs > 0) {
                setTimeout(append, config.appendDelayMs);
              } else {
                append();
              }
            });
          }
          section.appendChild(row);
          events.push("append:" + index);
        }

        dropdown.querySelectorAll('[role="option"]').forEach((option) => {
          option.addEventListener("click", () => {
            if (!activeRow) return;
            const index = Number(activeRow.dataset.index);
            const category = option.textContent.trim();
            const selectionItem = activeRow.querySelector("span.ant-select-selection-item");
            selectionItem.textContent = category;
            selectionItem.dataset.value = category;
            events.push("select:" + index + ":" + category);
            dropdown.classList.add("ant-select-dropdown-hidden");
          });
        });

        for (let index = 0; index < config.initialRows; index += 1) {
          if (config.initialCategories?.[index]) {
            appendRow(config.initialCategories[index], "");
          } else if (config.initialRows === 3) {
            appendRow("旧分类" + index, "旧文本" + index);
          } else {
            appendRow("", "");
          }
        }
      })();
    </script>
  `);
  return page;
}

async function recommendationState(page: Page) {
  return page.locator("#pm_recommend").first().locator(".ant-form-item").evaluateAll((rows) =>
    rows.map((row) => ({
      category: row.querySelector("span.ant-select-selection-item")?.getAttribute("data-value") ?? "",
      text: (row.querySelector("textarea.ant-input") as HTMLTextAreaElement | null)?.value,
    })),
  );
}

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
