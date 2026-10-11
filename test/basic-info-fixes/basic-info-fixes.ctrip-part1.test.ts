import {
  assert,
  basicInfoCompletenessIssues,
  findButlerOptionIndex,
  findFirstEnabledOptionIndex,
  findProvinceOptionIndex,
  fs,
  helperBody,
  isProductImageTextUrl,
  parseProduct,
  pickCityOption,
  pickKeySpotsFromItinerary,
  productFixture,
  PRODUCT_IMAGE_TEXT_PATH,
  readAutomationSource,
  readCtripSource,
  resolveAdvanceBooking,
  shouldRefillBasicInfo,
  stripComments,
  test,
} from "./basic-info-fixes.shared.js";
import { chromium } from "playwright";
import { fillScenicAreaProvince } from "../../src/main/automation/ctrip/basic-info/scenic.js";
import {
  clickLocatorSnapshotOption,
  getControlledDropdownOptions,
  readLocatorSnapshot,
} from "../../src/main/automation/ctrip/utils.js";

test("动态下拉候选被 React 替换后以单次 DOM 快照读取，不等待消失的旧索引", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <ul id="options">
        <li role="option" class="enabled"><span class="Name" title="中国-成都">中国-成都</span></li>
        <li role="option" class="enabled"><span class="Name" title="中国-四川">中国-四川</span></li>
      </ul>
    `);
    const options = page.locator("#options li[role=option]");
    assert.equal(await options.count(), 2);
    await page.evaluate(() => document.querySelector("#options li:last-child")?.remove());
    const startedAt = Date.now();
    const snapshot = await readLocatorSnapshot(options);
    assert.ok(Date.now() - startedAt < 500, "快照读取不得触发 Playwright 默认 30 秒自动等待");
    assert.deepEqual(snapshot.map(({ text, nameTitle }) => ({ text, nameTitle })), [
      { text: "中国-成都", nameTitle: "中国-成都" },
    ]);
  } finally {
    await browser.close();
  }
});

test("产品信息动态下拉禁止先 count 再逐个 nth 读取属性", async () => {
  for (const relative of [
    "src/main/automation/ctrip/basic-info/location.ts",
    "src/main/automation/ctrip/basic-info/scenic/province.ts",
    "src/main/automation/ctrip/basic-info/scenic/spots.ts",
    "src/main/automation/ctrip/basic-info/sections.ts",
  ]) {
    const source = await fs.readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /options?\.nth\(index\)\.(?:getAttribute|innerText)/, relative);
    assert.doesNotMatch(source, /options?\.nth\([^)]*\)\.click\(\)/, relative);
    assert.match(source, /readLocatorSnapshot/, relative);
    assert.match(source, /clickLocatorSnapshotOption/, relative);
  }
});

test("动态候选换序后按身份原子点击，不依赖失效索引或 actionability 等待", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <ul id="options">
        <li role="option"><span class="Name" title="中国-成都">中国-成都</span></li>
        <li role="option"><span class="Name" title="中国-四川">中国-四川</span></li>
      </ul>
      <output id="clicked"></output>
      <script>
        document.querySelector('#options').addEventListener('mousedown', (event) => {
          document.querySelector('#clicked').textContent = event.target.closest('li').innerText;
        });
      </script>
    `);
    const options = page.locator("#options li[role=option]");
    const snapshot = await readLocatorSnapshot(options);
    await page.evaluate(() => {
      const list = document.querySelector("#options");
      list.prepend(list.lastElementChild);
    });
    const startedAt = Date.now();
    assert.equal(await clickLocatorSnapshotOption(options, snapshot[0]), true);
    assert.ok(Date.now() - startedAt < 500, "原子点击不得触发 30 秒 actionability 等待");
    assert.equal(await page.locator("#clicked").textContent(), "中国-成都");
  } finally {
    await browser.close();
  }
});

test("多个未隐藏下拉并存时只读取当前 combobox 的 aria-controls 候选", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="combobox" id="province" aria-controls="province-options"></div>
      <div id="stale-product-line"><div role="option">成都一地</div></div>
      <div id="province-options"><div role="option">四川</div></div>
    `);
    const options = await getControlledDropdownOptions(page, page.locator("#province"));
    assert.deepEqual((await readLocatorSnapshot(options)).map((option) => option.text), ["四川"]);
  } finally {
    await browser.close();
  }
});

test("fillCitySelect 等待完整远程结果并按 title 精确选择城市", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  assert.match(body, /pickCityOption/);
  assert.match(body, /CITY_SEARCH_TIMEOUT_MS/);
  assert.match(body, /CITY_OPTION_SETTLE_MS/);
  assert.match(body, /stableMatchSince/,
    "城市候选首次出现后必须连续稳定，避免迟到响应覆盖已选值");
  assert.match(body, /stableMatchKey\s*=\s*""/,
    "Not Found 等中间态必须重置稳定计时并继续轮询");
  assert.match(body, /ant-select-selection-selected-value/);
  assert.match(body, /\.ant-select-selection/);
  assert.match(body, /input\.waitFor\(\{ state: "visible"/);
  assert.match(body, /await input\.fill\(city\)/, "城市搜索应一次输入完整关键词，避免旧的单字响应覆盖精确结果");
  assert.doesNotMatch(body, /input\.type\(city/, "城市远程搜索禁止逐字触发并发请求");
  assert.doesNotMatch(body, /title\.endsWith\(`-\$\{city\}`\)/, "城市 endsWith 命中第一项不安全，必须走国家-城市精确匹配");
  assert.doesNotMatch(body, /selectedText\.endsWith\(`-\$\{city\}`\)/, "幂等判断也必须验证国家，不能因 endsWith 跳过");
  assert.doesNotMatch(body, /getByRole\("combobox"\)\.click\(\)/, "收起状态不能点击隐藏 combobox");
  assert.doesNotMatch(body, /chosenIndex\s*=.*:\s*0/, "城市未精确命中时禁止默认第一项");
  assert.match(
    body,
    /return nameTitle \|\| title \|\| text/,
    "城市候选必须优先读取结构化 .Name title，避免把城市和省份两列拼接后交给 AI",
  );
});

test("fillCitySelect scoped 清空 Ant v3 单选：hover 后清除并等待隐藏", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  // scoped 到 select 容器内的 v3 单选清除按钮
  assert.match(
    body,
    /select\.locator\("\.ant-select-selection__clear"\)/,
    "清除按钮必须 scoped 到 select 容器内的 .ant-select-selection__clear",
  );
  // 把校验限定在 clear 块（前到 waitFor hidden，后到 catch 关闭大括号）
  const clearBlockStart = body.indexOf("const clear = select.locator");
  const clearBlockEnd = body.indexOf("selectedValue.waitFor", clearBlockStart) + "selectedValue.waitFor({ state: \"hidden\", timeout: 3_000 })".length;
  const clearBlock = body.slice(clearBlockStart, clearBlockEnd);
  // 顺序：hover → assertCount(1) → click → waitFor hidden
  const hoverIdx = clearBlock.indexOf("await select.hover()");
  const assertIdx = clearBlock.indexOf("await assertCount(clear, 1");
  const clickIdx = clearBlock.indexOf("await clear.click()");
  const waitIdx = clearBlock.indexOf("selectedValue.waitFor({ state: \"hidden\", timeout: 3_000 })");
  assert.ok(hoverIdx > 0, "缺少 select.hover()");
  assert.ok(assertIdx > 0, "缺少 assertCount(clear, 1, ...)");
  assert.ok(clickIdx > 0, "缺少 clear.click()");
  assert.ok(waitIdx > 0, "缺少 selectedValue.waitFor({ state: \"hidden\" })");
  assert.ok(hoverIdx < assertIdx, "hover 必须在 assertCount 之前");
  assert.ok(assertIdx < clickIdx, "assertCount 必须在 click 之前");
  assert.ok(clickIdx < waitIdx, "click 必须在 waitFor hidden 之前");
  // 兜底抛错
  assert.match(body, /无法清除已选城市：\$\{selectedText\}/);
  // 禁止 force / 禁止 fill 隐藏 input（仅限 clear 块内）
  assert.doesNotMatch(clearBlock, /clear\.click\(\{ force: true \}\)/, "清除按钮不允许 force");
  assert.doesNotMatch(clearBlock, /clear\.fill\(/, "清除按钮不能 fill");
  assert.doesNotMatch(clearBlock, /\binput\.fill\(/, "scoped clear 块内不能 fill 隐藏 input");
});

test("fillCitySelect 打开下拉：scoped click selection 后等 input 可见，超时只重试一次 scoped click", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  assert.match(body, /selection\.click\(\)/);
  assert.match(body, /select\.locator\("input\.ant-select-search__field"\)/);
  assert.match(body, /input\.waitFor\(\{ state: "visible", timeout: 5_000 \}\)/);
  // 重试路径：catch 里再点一次 selection scoped click，绝不 force，绝不 fill 隐藏 input
  // 第二次 waitFor 出现在 catch 块内（catch 没有绑定变量），取第二处。
  const firstWaitIdx = body.indexOf("input.waitFor({ state: \"visible\", timeout: 5_000 })");
  const secondWaitIdx = body.indexOf("input.waitFor({ state: \"visible\", timeout: 5_000 })", firstWaitIdx + 1);
  assert.ok(secondWaitIdx > 0, "找不到 catch 内的二次 waitFor");
  const tryIdx = body.lastIndexOf("try {", secondWaitIdx);
  assert.ok(tryIdx > 0, "找不到输入框可见性的 try");
  // 第二次 waitFor 之后取一段窗口：包含整个 catch 块尾部
  const tailStart = secondWaitIdx;
  const tailEnd = body.indexOf("await input.fill(", tailStart);
  assert.ok(tailEnd > 0, "找不到 catch 之后的 input.fill");
  const retryBlock = body.slice(tryIdx, tailEnd);
  assert.match(retryBlock, /selection\.click\(\)/, "重试必须再次 scoped 点击 selection");
  assert.doesNotMatch(retryBlock, /force:\s*true/, "重试不允许 force");
  assert.doesNotMatch(retryBlock, /\binput\.fill\(/, "重试不允许 fill 隐藏 input");
});

test("fillProductLine 优先城市一地、回退省份一地，未命中时跳过", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillProductLine");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0, "找不到 fillProductLine 定义");
  assert.match(body, /baseInfo\.productLineID/);
  assert.match(body, /destinationCity[\s\S]*一地/);
  assert.match(body, /provinceBase[\s\S]*一地/);
  assert.match(body, /Date\.now\(\) \+ 3_000/);
  assert.match(body, /candidates\.includes\(text\)/);
  assert.match(body, /暂无数据/);
  assert.match(body, /skipped: no matching optional product line/);
  assert.match(body, /skipped: product line options timeout/);
  assert.doesNotMatch(body, /options\.(?:first|nth\(0\))/, "产品线禁止默认第一项");
  assert.doesNotMatch(body, /throw new Error\(`产品线/, "产品线是可选项，未命中不应阻断 basic 阶段");
});

test("fillBasicInfo 在城市后录入产品线", async () => {
  const source = readCtripSource();
  const start = source.indexOf("export async function fillBasicInfo");
  const body = source.slice(start, source.indexOf("\n/**", start));
  const cityAnchor = body.indexOf('fillCitySelect(page, "baseInfo.destinationCityID"');
  const lineAnchor = body.indexOf("fillProductLine(page, info.destinationCity, info.province)");
  assert.ok(cityAnchor >= 0 && lineAnchor > cityAnchor, "产品线必须在目的城市之后录入");
});

test("fillBasicInfo 按 VBK 产品信息页面从上到下录入已覆盖字段", async () => {
  const source = readCtripSource();
  const start = source.indexOf("export async function fillBasicInfo");
  const body = source.slice(start, source.indexOf("\nexport function stripIllegalKeywords", start));
  const anchors = [
    ["国家景区", "fillScenicAreaProvince(page, info.province, cityContext)"],
    ["行程天数", "numberInputs.nth(0).fill"],
    ["副标题", 'fillById(page, "baseInfo.subName"'],
    ["供应商产品名称", '"baseInfo.providerProductName"'],
    ["供应商产品编号", '"baseInfo.vendorProductCode"'],
    ["集合城市", '"baseInfo.masterDepartureCityId"'],
    ["目的城市", '"baseInfo.destinationCityID"'],
    ["产品线", "fillProductLine(page, info.destinationCity, info.province)"],
    ["400 电话", "fillServicePhone(page, servicePhone)"],
    ["操作说明", '"baseInfo.operationNote"'],
    ["提前预订", "fillAdvanceBooking(page, advance)"],
    ["联系人", "fillButlerContact(page, butlerSelection"],
  ];
  let previous = -1;
  for (const [label, anchor] of anchors) {
    const index = body.indexOf(anchor);
    assert.ok(index >= 0, `找不到 ${label} 录入锚点`);
    assert.ok(index > previous, `${label} 录入顺序不应早于前一项`);
    previous = index;
  }
});

test("基本信息重试会关闭残留提示弹窗", async () => {
  const source = readCtripSource();
  assert.match(source, /async function dismissKnownNoticeDialogs/);
  assert.match(source, /保存成功\|不能输入重复的国家或省或景区、景点、其他地区/);
  assert.match(source, /我知道了\|知道了/);
  assert.match(source, /waitForSaveSuccess \? 5_000 : 800/);
  assert.match(source, /dialog\.waitFor\(\{ state: "hidden", timeout: 3_000 \}\)/);
  assert.match(source, /Cannot find context\|Execution context was destroyed\|Target closed/,
    "保存确认触发导航时应把旧执行上下文消失视为原弹窗已离开");
  const saveStart = source.indexOf("async function clickSafeSave");
  const saveBody = source.slice(saveStart, source.indexOf("\nasync function dismissKnownNoticeDialogs", saveStart));
  assert.match(saveBody, /current\.innerText\(\).*\.replace\(\/\\s\+\/g, ""\)/s);
  assert.match(saveBody, /text === name\.replace\(\/\\s\+\/g, ""\)/);
  assert.match(saveBody, /dismissKnownNoticeDialogs\(page, \{ waitForSaveSuccess: true \}\)/);
  const start = source.indexOf("export async function fillAndSaveBasicInfo");
  const body = source.slice(start, source.indexOf("\nasync function fillFirstVisible", start));
  assert.match(body, /dismissKnownNoticeDialogs\(page\)/);
  // basic 阶段的「下一步」与「产品图文/图文信息」tab 切换全部由新通用
  // saveThenAdvance 负责；fillAndSaveBasicInfo 不再直接调
  // waitForSectionEnabled/clickSection 走 tab 路径。
  assert.match(body, /saveThenAdvance\(page, \{/);
  assert.doesNotMatch(body, /waitForSectionEnabled\(page, \["产品图文", "图文信息"\]\)/);
  assert.doesNotMatch(body, /clickSection\(page, \["产品图文", "图文信息"\]\)/);
});

import "./basic-info-fixes.ctrip-part1.cases.js";
