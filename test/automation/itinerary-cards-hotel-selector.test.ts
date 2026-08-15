// @ts-nocheck
/**
 * 锁死 fillHotelCard 的「酒店名称 combobox 选择器」三向分支契约：
 *
 *   - 历史 bug：cards.ts 用 `getByRole("combobox").last()` 把 ant-select-disabled 的
 *     「具体时间」下拉误当酒店名称选择器，进而 selectVisibleOption 抛
 *     「当地3钻酒店/-3 数量异常：期望 1，实际 0」。
 *   - 修复：枚举 hotelCard 内所有 role=combobox，沿 DOM 向上找最近的 `.ant-select`
 *     祖先，必须存在且不携带 `ant-select-disabled`（VBK 真实 DOM 暴露的「时间下拉」
 *     禁用标记）；辅以 input 自身 disabled / aria-disabled / 父文本「具体时间」兜底。
 *   - 行为契约（fillHotelCard 真实行为，由 chromium + page.setContent 注入 fake DOM）：
 *       0 个可用 → 跳过 selectVisibleOption，console.warn 提示「跳过钻级下拉选择」，
 *                  补充说明被填，由后续 ensureHotelResource 补全酒店资源；
 *       1 个可用 → 保持既有的 click + selectVisibleOption(tierKeyword)；
 *                  3钻 → 选「当地3钻酒店/-3」；4钻 → 选「当地4钻酒店/-4」；
 *       多于 1 个 → 抛「期望 1，实际 N」明确错误，绝不静默退化为选第一个。
 *   - 不能动的：fillMealCards 路径（含 assertCount 真实导入与「不含餐」契约）。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import {
  fillHotelCard,
  getAvailableHotelSelectors,
} from "../../src/main/automation/ctrip/itinerary/cards.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cardsPath = path.join(
  __dirname,
  "../../src/main/automation/ctrip/itinerary/cards.ts",
);

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function newPage(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

/** 注入一组「具体时间」禁用下拉（2 个，模拟 VBK 真实 DOM）+ 可变数量 enabled 酒店下拉 + 选项。 */
function buildHotelCardHtml(opts: {
  enabledCombos: number;
  includeOptions?: boolean;
  tierKeyword?: string;
}): string {
  const enabledCombos = Array.from(
    { length: opts.enabledCombos },
    (_, i) => `
      <div class="ant-select">
        <div class="ant-select-selector">
          <span class="ant-select-selection-search">
            <input class="ant-select-selection-search-input" role="combobox" data-testid="hotel-combo-${i}" />
          </span>
        </div>
      </div>
    `,
  ).join("");
  const disabledCombos = `
    <div class="ant-select ant-select-disabled">
      <div class="ant-select-selector">
        <span class="ant-select-selection-search">
          <input class="ant-select-selection-search-input" role="combobox" data-testid="time-combo-0" aria-disabled="true" />
        </span>
      </div>
    </div>
    <div class="ant-select ant-select-disabled">
      <div class="ant-select-selector">
        <span class="ant-select-selection-search">
          <input class="ant-select-selection-search-input" role="combobox" data-testid="time-combo-1" aria-disabled="true" />
        </span>
      </div>
    </div>
  `;
  const options = opts.includeOptions
    ? `
      <ul role="listbox">
      <li role="option" data-option-key="3" tabindex="0">当地3钻酒店/-3</li>
      <li role="option" data-option-key="4" tabindex="0">当地4钻酒店/-4</li>
      <li role="option" data-option-key="5" tabindex="0">当地5钻酒店/-38</li>
      </ul>
    `
    : "";
  return `
    <style>.ant-select-dropdown-hidden { display: none; }</style>
    <div id="day-scope">
      <div class="td-day-card--hotel">
        <span>酒店</span>
        <span>具体酒店信息以后续资源配置内容为准</span>
        <div><span>不限</span></div>
        <label class="ant-radio-wrapper">
          <span class="ant-radio"><input type="radio" name="hotel-source" /></span>
          <span>使用携程平台酒店</span>
        </label>
        <div>
          <span>具体时间</span>
          ${disabledCombos}
        </div>
        <div>${enabledCombos}</div>
        <textarea placeholder="请输入补充说明"></textarea>
      </div>
    </div>
    ${options}
    <script>
      document.querySelectorAll('label.ant-radio-wrapper').forEach((label) => {
        label.addEventListener('click', () => {
          document.querySelectorAll('label.ant-radio-wrapper').forEach((item) => item.classList.remove('ant-radio-wrapper-checked'));
          label.classList.add('ant-radio-wrapper-checked');
          const input = label.querySelector('input[type="radio"]');
          if (input) input.checked = true;
        });
      });
    </script>
  `;
}

// ─────────────────────────── source-level invariants ───────────────────────────

test("cards.ts：fillHotelCard 不能再用 .last() 兜底酒店 combobox（历史 bug 锁定）", async () => {
  const src = await fs.readFile(cardsPath, "utf8");
  assert.doesNotMatch(
    src,
    /combos\.last\(\)\.click\(\)/,
    "fillHotelCard 不能再用 combos.last() 把禁用时间下拉当酒店选择器（历史 bug）",
  );
});

test("酒店来源必须通过可见 label 驱动 React，禁止直接 check 或伪造 DOM 选中态", async () => {
  const src = await fs.readFile(cardsPath, "utf8");
  const sourceSelection = src.slice(
    src.indexOf("async function selectHotelSource"),
    src.indexOf("function hotelTierKeyword"),
  );
  assert.doesNotMatch(sourceSelection, /\.check\s*\(/);
  assert.doesNotMatch(sourceSelection, /\.checked\s*=/);
  assert.doesNotMatch(sourceSelection, /classList\.add/);
  assert.match(sourceSelection, /clickable\.click\(\{ force: true \}\)/);
  assert.match(sourceSelection, /isHotelSourceSelectionStable/);
});

test("cards.ts：必须导出 getAvailableHotelSelectors 并以 .ant-select-disabled 为主判据", async () => {
  const src = await fs.readFile(cardsPath, "utf8");
  // 1) 必须显式 export，供 fillHotelCard 复用 + 配套测试做单测断言
  assert.match(
    src,
    /export\s+async\s+function\s+getAvailableHotelSelectors\s*\(/,
    "cards.ts 必须显式 export getAvailableHotelSelectors",
  );
  // 2) 必须真的检查 .ant-select-disabled 祖先（不只是 parent text 兜底）
  assert.match(
    src,
    /ant-select-disabled/,
    "getAvailableHotelSelectors 必须以 .ant-select-disabled 祖先作为主判据（VBK 真实 DOM 暴露的禁用标记）",
  );
  // 3) 必须保留餐饮路径的 assertCount 真实导入与「不含餐」契约
  assert.match(
    src,
    /import\s*\{[^}]*\bassertCount\b[^}]*\}\s*from\s*"\.\.\/utils\.js"/,
    "cards.ts 必须保持从 ../utils.js 真实导入 assertCount（餐饮「不含餐」选项断言依赖）",
  );
  assert.match(
    src,
    /await\s+assertCount\s*\(\s*noMeal\s*,\s*2\s*,\s*`第\s*\$\{day\.day\}\s*天\$\{types\[index\]\}不含餐选项`\s*\)/,
    "fillMealCards 内必须 await assertCount(noMeal, 2, `第 ${day.day} 天${types[index]}不含餐选项`)",
  );
  assert.match(
    src,
    /await\s+ensureCheckboxChecked\s*\(\s*noMeal\.nth\s*\(\s*0\s*\)\s*\)/,
    "fillMealCards 必须用 ensureCheckboxChecked(noMeal.nth(0)) 幂等勾选",
  );
  // 4) 不能再保留任何 declare-only 占位（运行期会 ReferenceError）
  assert.doesNotMatch(
    src,
    /^\s*declare\s+(?:function|var|const|let)\s+(?:assertCount|selectVisibleOption|delay)\b/m,
    "cards.ts 不得再使用 declare-only 占位声明 utils 里的函数",
  );
});

test("cards.ts：fillHotelCard 三类分支契约（0 / 1 / 多于 1）必须互不交叉", async () => {
  const src = await fs.readFile(cardsPath, "utf8");
  // 1) 多于 1：明确失败，错误必须含「期望 1」+「实际 N」（明确失败 ≠ 期望最多 1）
  assert.match(
    src,
    /hotelNameCombos\.length\s*>\s*1[\s\S]*?throw\s+new\s+Error\s*\([\s\S]*?期望\s*1[\s\S]*?实际\s*\$\{hotelNameCombos\.length\}/,
    "多于 1 时必须 throw new Error，错误消息必须含「期望 1」与「实际 ${availableCombos.length}」",
  );
  // 2) 等于 1：必须 click + selectVisibleOption，tierKeyword 必须支持 3/4/5 钻
  assert.match(
    src,
    /hotelNameCombos\.length\s*===\s*1[\s\S]*?selectVisibleOption\s*\(\s*page\s*,\s*hotelTierKeyword\(operations\.hotelTier\)\s*\)/,
    "等于 1 时必须 click + selectVisibleOption(page, hotelTierKeyword(operations.hotelTier))",
  );
  assert.match(
    src,
    /hotelDiamondFromTier\(hotelTier\)[\s\S]*?"当地5钻酒店\/-38"[\s\S]*?"当地4钻酒店\/-4"[\s\S]*?"当地3钻酒店\/-3"/,
    "tierKeyword 必须通过 hotelDiamondFromTier 支持「当地5钻酒店/-38」「当地4钻酒店/-4」「当地3钻酒店/-3」",
  );
  // 3) 等于 0：必须走 else 分支并通过 logWarn 输出可观测 warn（不调用 selectVisibleOption）
  assert.match(
    src,
    /\}\s*else\s*\{[\s\S]*?logWarn\([\s\S]*?跳过钻级下拉选择/,
    "0 个可用时必须走 else 分支并 logWarn「跳过钻级下拉选择」",
  );
  // 4) 补充说明 fill 必须出现在 0 分支的 console.warn 之后（即 0-case 仍写补充说明）
  const warnIdx = src.indexOf("跳过钻级下拉选择");
  // 必须找酒店路径下的 supplement.first().fill（fillMealCards 那一份不算）
  const hotelSupplementFillIdx = src.indexOf("supplement.first().fill(day.hotelDescription");
  assert.ok(
    warnIdx > 0 && hotelSupplementFillIdx > warnIdx,
    "酒店补充说明 fill 必须在 0 分支的 console.warn 之后执行（0-case 必须继续写补充说明）",
  );
});

// ─────────────────────────── behavior tests ───────────────────────────

test("酒店 card 仅 2 个 ant-select-disabled 时间下拉：fillHotelCard 不调用钻级选择且补充说明写入", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 0, includeOptions: false });
  const page = await newPage(html);
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const dayScope = page.locator("#day-scope");
    // 这里不允许抛错：selectVisibleOption 会断言 option 数量 = 1，没有 option 就抛；
    // fillHotelCard 不抛 = 走 0 分支 = 没调用 selectVisibleOption（间接强证据）。
    await fillHotelCard(
      page,
      dayScope,
      { day: 1, hotelDescription: "由 ensureHotelResource 补全" },
      { hotelTier: "当地3钻酒店/-3" },
    );
    // 补充说明必须被填（0-case 不能丢数据）
    const supplement = page.locator('textarea[placeholder="请输入补充说明"]');
    const filled = await supplement.inputValue();
    assert.equal(filled, "由 ensureHotelResource 补全", "0-case 必须把 day.hotelDescription 写入补充说明");
    // warn 提示运营「跳过钻级下拉选择」，便于人工追查
    assert.ok(
      warnings.some((w) => /跳过钻级下拉选择/.test(w)),
      "0-case 必须 console.warn 提示「跳过钻级下拉选择」",
    );
  } finally {
    console.warn = origWarn;
    await page.close();
  }
});

test("酒店 card 一个可用酒店下拉：3钻 时 fillHotelCard 选「当地3钻酒店/-3」", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 1, includeOptions: true });
  const page = await newPage(html);
  try {
    // 在 page context 注入点击监听：记录实际命中的 tier
    await page.evaluate(() => {
      const w = window;
      // @ts-ignore
      w.__lastClicked = null;
      document.querySelectorAll('[role="option"]').forEach((el) => {
        el.addEventListener(
          "click",
          () => {
            // @ts-ignore
            w.__lastClicked = el.getAttribute("data-option-key") || el.textContent || "";
          },
          { once: true },
        );
      });
    });
    const dayScope = page.locator("#day-scope");
    await fillHotelCard(
      page,
      dayScope,
      { day: 1, hotelDescription: "X" },
      { hotelTier: "当地3钻酒店/-3" },
    );
    // 跨进程稳妥起见小等一拍
    await page.waitForTimeout(50);
    const lastClicked = await page.evaluate(() => {
      // @ts-ignore
      return window.__lastClicked;
    });
    assert.equal(lastClicked, "3", "3钻 时必须 selectVisibleOption 选「当地3钻酒店/-3」");
    const supplement = page.locator('textarea[placeholder="请输入补充说明"]');
    assert.equal(await supplement.inputValue(), "X", "1-case 仍必须把 hotelDescription 写进补充说明");
  } finally {
    await page.close();
  }
});

test("酒店 card 一个可用酒店下拉：4钻 时 fillHotelCard 选「当地4钻酒店/-4」", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 1, includeOptions: true });
  const page = await newPage(html);
  try {
    await page.evaluate(() => {
      const w = window;
      // @ts-ignore
      w.__lastClicked = null;
      document.querySelectorAll('[role="option"]').forEach((el) => {
        el.addEventListener(
          "click",
          () => {
            // @ts-ignore
            w.__lastClicked = el.getAttribute("data-option-key") || el.textContent || "";
          },
          { once: true },
        );
      });
    });
    const dayScope = page.locator("#day-scope");
    await fillHotelCard(
      page,
      dayScope,
      { day: 1, hotelDescription: "Y" },
      { hotelTier: "当地4钻酒店/-4" },
    );
    await page.waitForTimeout(50);
    const lastClicked = await page.evaluate(() => {
      // @ts-ignore
      return window.__lastClicked;
    });
    assert.equal(lastClicked, "4", "4钻 时必须 selectVisibleOption 选「当地4钻酒店/-4」");
  } finally {
    await page.close();
  }
});

test("酒店 card 一个可用酒店下拉：5钻 时 fillHotelCard 选「当地5钻酒店/-38」", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 1, includeOptions: true });
  const page = await newPage(html);
  try {
    await page.evaluate(() => {
      const w = window;
      // @ts-ignore
      w.__lastClicked = null;
      document.querySelectorAll('[role="option"]').forEach((el) => {
        el.addEventListener("click", () => {
          // @ts-ignore
          w.__lastClicked = el.getAttribute("data-option-key") || el.textContent || "";
        }, { once: true });
      });
    });
    await fillHotelCard(
      page,
      page.locator("#day-scope"),
      { day: 1, hotelDescription: "Z" },
      { hotelTier: "当地5钻酒店/-38" },
    );
    await page.waitForTimeout(50);
    const lastClicked = await page.evaluate(() => {
      // @ts-ignore
      return window.__lastClicked;
    });
    assert.equal(lastClicked, "5", "5钻 时必须 selectVisibleOption 选「当地5钻酒店/-38」");
  } finally {
    await page.close();
  }
});

test("酒店来源点击后未形成 radio checked 时必须失败，不能继续静默保存", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 0, includeOptions: false }).replace(
    /<label class="ant-radio-wrapper">[\s\S]*?<\/label>/,
    "<div><span>使用携程平台酒店</span></div>",
  );
  const page = await newPage(html);
  try {
    await assert.rejects(
      () => fillHotelCard(
        page,
        page.locator("#day-scope"),
        { day: 1, hotelDescription: "来源必须失败" },
        { hotelTier: "当地3钻酒店/-3" },
      ),
      /酒店来源未选中/,
    );
  } finally {
    await page.close();
  }
});

test("酒店来源首次点击被 React 重渲染覆盖时会重新点击并稳定选中", async () => {
  const page = await newPage(`
    <div id="day-scope">
      <div class="td-day-card--hotel">
        <span>酒店</span><span>不限</span>
        <label class="ant-radio-wrapper" id="platform-source">
          <span class="ant-radio"><input type="radio" name="hotel-source" /></span>
          <span>使用携程平台酒店</span>
        </label>
        <textarea placeholder="请输入补充说明"></textarea>
      </div>
    </div>
    <script>
      let clicks = 0;
      const label = document.querySelector('#platform-source');
      const input = label.querySelector('input');
      label.addEventListener('click', (event) => {
        clicks += 1;
        if (clicks === 1) {
          event.preventDefault();
          input.checked = false;
          label.classList.remove('ant-radio-wrapper-checked');
          return;
        }
        input.checked = true;
        label.classList.add('ant-radio-wrapper-checked');
      });
    </script>
  `);
  try {
    await fillHotelCard(
      page,
      page.locator("#day-scope"),
      { day: 1, hotelDescription: "稳定重试" },
      { hotelTier: "当地3钻酒店/-3" },
    );
    assert.equal(await page.locator("#platform-source input").isChecked(), true);
    assert.match(await page.locator("#platform-source").getAttribute("class") || "", /checked/);
  } finally {
    await page.close();
  }
});

test("新版酒店 card 同时有住宿类型和酒店名称下拉时优先选择酒店名称", async () => {
  const html = `
    <div id="day-scope">
      <div class="td-day-card--hotel">
        <span>酒店</span><span>不限</span>
        <label class="ant-radio-wrapper">
          <span class="ant-radio"><input type="radio" name="hotel-source" /></span>
          <span>使用携程平台酒店</span>
        </label>
        <div class="ant-form-item"><label>住宿类型</label>
          <div class="ant-select"><input role="combobox" data-testid="lodging-type" /></div>
        </div>
        <div class="ant-form-item"><label>酒店名称</label>
          <div class="ant-select"><input role="combobox" data-testid="hotel-name" /></div>
        </div>
        <textarea placeholder="请输入补充说明"></textarea>
      </div>
    </div>
    <ul role="listbox">
      <li role="option" data-option-key="3">当地3钻酒店/-3</li>
    </ul>`;
  const page = await newPage(html);
  try {
    await page.evaluate(() => {
      document.querySelector('[data-testid="hotel-name"]')?.addEventListener("click", () => {
        // @ts-ignore
        window.__hotelClicked = true;
      });
      document.querySelector('[data-testid="lodging-type"]')?.addEventListener("click", () => {
        // @ts-ignore
        window.__lodgingClicked = true;
      });
    });
    await fillHotelCard(
      page,
      page.locator("#day-scope"),
      { day: 1, hotelDescription: "新版" },
      { hotelTier: "当地3钻酒店/-3" },
    );
    assert.equal(await page.evaluate(() => window.__hotelClicked), true);
    assert.equal(await page.evaluate(() => window.__lodgingClicked), undefined);
  } finally {
    await page.close();
  }
});

test("新版酒店 card 的多类名 ant-form-item 仍按标签筛出酒店名称下拉", async () => {
  const html = `
    <div id="day-scope">
      <div class="td-day-card--hotel">
        <span>酒店</span><span>不限</span>
        <label class="ant-radio-wrapper">
          <span class="ant-radio"><input type="radio" name="hotel-source" /></span>
          <span>使用携程平台酒店</span>
        </label>
        <div class="ant-form-item ant-form-item-control"><label>住宿类型</label>
          <div class="ant-select"><input role="combobox" data-testid="lodging-type" /></div>
        </div>
        <div class="ant-form-item ant-form-item-control"><label>酒店名称</label>
          <div class="ant-select"><input role="combobox" data-testid="hotel-name" /></div>
        </div>
        <textarea placeholder="请输入补充说明"></textarea>
      </div>
    </div>
    <ul role="listbox">
      <li role="option" data-option-key="3">当地3钻酒店/-3</li>
    </ul>`;
  const page = await newPage(html);
  try {
    await page.evaluate(() => {
      document.querySelector('[data-testid="hotel-name"]')?.addEventListener("click", () => {
        // @ts-ignore
        window.__hotelClicked = true;
      });
      document.querySelector('[data-testid="lodging-type"]')?.addEventListener("click", () => {
        // @ts-ignore
        window.__lodgingClicked = true;
      });
    });
    await fillHotelCard(page, page.locator("#day-scope"), { day: 1, hotelDescription: "新版" }, { hotelTier: "当地3钻酒店/-3" });
    assert.equal(await page.evaluate(() => window.__hotelClicked), true);
    assert.equal(await page.evaluate(() => window.__lodgingClicked), undefined);
  } finally {
    await page.close();
  }
});

test("酒店 card 多个可用酒店下拉：fillHotelCard 抛「期望 1，实际 N」明确错误", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 2, includeOptions: false });
  const page = await newPage(html);
  const origWarn = console.warn;
  console.warn = () => {}; // 静音 warn
  try {
    const dayScope = page.locator("#day-scope");
    await assert.rejects(
      () =>
        fillHotelCard(
          page,
          dayScope,
          { day: 1, hotelDescription: "Z" },
          { hotelTier: "当地3钻酒店/-3" },
        ),
      (error: Error) => {
        assert.match(error.message, /期望\s*1/, "错误必须说「期望 1」（不是「最多 1」）");
        assert.match(error.message, /实际\s*2/, "错误必须说「实际 2」");
        assert.match(error.message, /第\s*1\s*天/, "错误必须包含「第 1 天」便于排查");
        return true;
      },
    );
    // 多个可用时绝不写补充说明（throw 在 supplement fill 之前）
    const supplement = page.locator('textarea[placeholder="请输入补充说明"]');
    const filled = await supplement.inputValue();
    assert.equal(filled, "", "多于 1 时 fillHotelCard 必须 throw，绝不能继续写补充说明");
  } finally {
    console.warn = origWarn;
    await page.close();
  }
});

test("getAvailableHotelSelectors 单元契约：仅 .ant-select 非 disabled 包装的 combobox 被纳入", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 1 });
  const page = await newPage(html);
  try {
    const dayScope = page.locator("#day-scope");
    const combos = dayScope.getByRole("combobox");
    const total = await combos.count();
    assert.equal(total, 3, "fake DOM 必须渲染 3 个 combobox：1 个 enabled + 2 个 disabled 时间下拉");
    const available = await getAvailableHotelSelectors(combos);
    assert.equal(available.length, 1, "1 个 enabled + 2 个 disabled 共 3 个 combobox 下，应只返回 1 个");
  } finally {
    await page.close();
  }
});

test("getAvailableHotelSelectors 单元契约：0 个 enabled 时返回空数组（不抛错）", async () => {
  const html = buildHotelCardHtml({ enabledCombos: 0 });
  const page = await newPage(html);
  try {
    const dayScope = page.locator("#day-scope");
    const combos = dayScope.getByRole("combobox");
    const total = await combos.count();
    assert.equal(total, 2, "fake DOM 应只渲染 2 个 disabled 时间下拉");
    const available = await getAvailableHotelSelectors(combos);
    assert.equal(available.length, 0, "0 个 enabled 时 getAvailableHotelSelectors 必须返回空数组");
  } finally {
    await page.close();
  }
});
