// saveThenAdvance 真实幂等回归锁：
//   真实 VBK tourdays 页（行程已提交/产品已存盘）真实状态：
//     - 行程 tab active；
//     - 套餐管理 tab aria-disabled=false 可点击；
//     - 底部只剩「存为草稿 / 提交审核」，不再出现预期的「提交审核并下一步」；
//     - 无校验错误。
//   旧契约：saveThenAdvance 在 buttons.count() != 1 时直接抛「按钮数量异常」，
//   真实成功路径会被误判失败。本批测试锁死新契约：
//     1) count === 0 + 目标已解锁 → clickSection + return tabAlreadyUnlocked；
//     2) count === 0 + 目标仍锁定 → 抛原数量异常；
//     3) count === 1 + 目标已解锁 → 仍走按钮点击（不提前跳过到 tabAlreadyUnlocked）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { saveThenAdvance } from "../../src/main/automation/ctrip/tabs.js";

/**
 * 构造一个最小可观察的 VBK tourdays 页面：
 *   - 「存为草稿」保存按钮；
 *   - 0 或 1 个「提交审核并下一步」按钮（由 withNextButton 控制）；
 *   - 「套餐管理」tab：aria-selected="false"，aria-disabled 由 tabUnlocked 控制；
 *   - 顶部一个隐藏脚本用于记录事件顺序。
 */
async function setupTourdaysPage(browser, options) {
  const page = await browser.newPage();
  const { withNextButton, tabUnlocked } = options;
  await page.setContent(`
    <button id="save">存为草稿</button>
    ${withNextButton ? '<button id="next">提交审核并下一步</button>' : ""}
    <div role="tab" id="package" aria-selected="false" aria-disabled="${tabUnlocked ? "false" : "true"}">套餐管理</div>
    <script>
      window.events = [];
      const save = document.querySelector('#save');
      const next = document.querySelector('#next');
      const pkg = document.querySelector('#package');
      save.addEventListener('click', () => window.events.push('save'));
      if (next) next.addEventListener('click', () => window.events.push('next'));
      pkg.addEventListener('click', () => {
        window.events.push('click:package');
        pkg.setAttribute('aria-selected', 'true');
      });
    </script>
  `);
  return page;
}

const COMMON_OPTIONS = {
  phase: "行程",
  targetTabLabel: "套餐管理",
  saveButtonNames: ["存为草稿"],
  targetTabLabels: ["套餐管理"],
  nextButtonLabel: "提交审核并下一步",
  isTargetUrl: () => false,
};

test("幂等 1：count===0 + 目标已解锁 → 探测 unlocked → clickSection → tabAlreadyUnlocked", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await setupTourdaysPage(browser, { withNextButton: false, tabUnlocked: true });
    const result = await saveThenAdvance(page, COMMON_OPTIONS);
    assert.equal(result.advanced, true, "必须返回 advanced=true（幂等成功）");
    assert.equal(result.mode, "tabAlreadyUnlocked", "必须走 tabAlreadyUnlocked 分支");
    assert.equal(result.savedWith, "存为草稿", "savedWith 必须等于保存按钮名");
    const events = await page.evaluate(() => window.events);
    // 必须先存为草稿，再探测目标 tab 已解锁并 clickSection。绝不能点「下一步」（按钮不存在）。
    assert.ok(events.includes("save"), "必须先点存为草稿");
    assert.ok(events.includes("click:package"), "目标 tab 必须被点击落点");
    assert.ok(!events.includes("next"), "count===0 时不得触发「提交审核并下一步」点击");
    // 顺序：save → click:package（中间允许 dismissKnownNoticeDialogs 等副作用，但 next 不在）。
    assert.equal(events[events.length - 1], "click:package", "clickSection 必须在 save 之后");
    const selected = await page.locator("#package").getAttribute("aria-selected");
    assert.equal(selected, "true", "目标 tab 必须已被 clickSection 激活为 aria-selected=true");
  } finally {
    await browser.close();
  }
});

test("幂等 2：count===0 + 目标仍锁定 → 抛原「按钮数量异常」错误（不提前跳过到 clickSection）", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await setupTourdaysPage(browser, { withNextButton: false, tabUnlocked: false });
    await assert.rejects(
      () => saveThenAdvance(page, COMMON_OPTIONS),
      (error) => {
        // 必须抛「按钮数量异常」原错误，且实际值明确为 0。
        assert.match(error.message, /按钮数量异常/, "必须抛原数量异常错误");
        assert.match(error.message, /期望\s*1，实际\s*0/, "实际值必须明确为 0");
        assert.match(error.message, /目标 tab=套餐管理/, "必须带目标 tab 上下文");
        assert.match(error.message, /观测 URL=/, "必须带观测 URL 上下文");
        return true;
      },
    );
    const events = await page.evaluate(() => window.events);
    // save 仍必须被点（保存逻辑先于按钮数量探测），但目标 tab 不能被点。
    assert.ok(events.includes("save"), "保存按钮必须先被点");
    assert.ok(!events.includes("click:package"), "目标锁定时不得 clickSection（避免误落点）");
    assert.ok(!events.includes("next"), "count===0 时不得触发「下一步」点击");
  } finally {
    await browser.close();
  }
});

test("幂等 3：count===1 + 目标已解锁 → 仍走原按钮点击路径（不提前跳过到 tabAlreadyUnlocked）", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await setupTourdaysPage(browser, { withNextButton: true, tabUnlocked: true });
    const result = await saveThenAdvance(page, COMMON_OPTIONS);
    assert.equal(result.advanced, true, "必须返回 advanced=true");
    // 关键反向断言：count > 0 时模式不能是 tabAlreadyUnlocked，否则就是
    // 「按钮仍存在时提前跳过点击」的反例，必须沿原路径走按钮点击。
    assert.notEqual(
      result.mode,
      "tabAlreadyUnlocked",
      "count===1 时禁止提前跳过到 tabAlreadyUnlocked（必须走按钮点击路径）",
    );
    const events = await page.evaluate(() => window.events);
    // 必须先 save → next（按钮点击路径），clickSection 在 next 之后的 gate 循环里被调用。
    assert.ok(events.includes("save"), "必须先点存为草稿");
    assert.ok(events.includes("next"), "count===1 时必须实际点击「提交审核并下一步」");
    const nextIdx = events.indexOf("next");
    const packageIdx = events.indexOf("click:package");
    assert.ok(nextIdx >= 0, "next 事件必须存在");
    assert.ok(packageIdx > nextIdx, "clickSection 必须在 next 之后（按钮点击路径内的 gate 兜底）");
  } finally {
    await browser.close();
  }
});

test("幂等 4：count===0 走 tabAlreadyUnlocked 后，effectiveSavedWith 透传（外部传入 savedWith 也保留）", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await setupTourdaysPage(browser, { withNextButton: false, tabUnlocked: true });
    // 显式传 savedWith 模拟调用方已经走过 clickSafeSave 的场景；
    // 必须不再次点「存为草稿」，且 savedWith 必须原样透传。
    const result = await saveThenAdvance(page, { ...COMMON_OPTIONS, savedWith: "保存并下一步" });
    assert.equal(result.mode, "tabAlreadyUnlocked");
    assert.equal(result.savedWith, "保存并下一步", "savedWith 必须原样透传");
    const events = await page.evaluate(() => window.events);
    assert.ok(!events.includes("save"), "外部传入 savedWith 时不得再点存为草稿");
    assert.ok(events.includes("click:package"), "目标 tab 仍必须被 clickSection 落点");
  } finally {
    await browser.close();
  }
});
