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
import { fillScenicAreaSpots } from "../../src/main/automation/ctrip/basic-info/scenic.js";

test("fillScenicAreaSpots 已提交 choice 命中后跳过（part2 主链路锁定）", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-select-selection__choice" title="西安城墙（西安/陕西/中国）">
          <span class="ant-select-selection__choice__content">西安城墙（西安/陕西/中国）</span>
          <span class="ant-select-selection__choice__remove">×</span>
        </span>
        <div id="country" role="combobox">
          <span class="ant-select-selection-item" title="中国">中国</span>
          <input class="ant-select-search__field" placeholder="国家" />
        </div>
        <div id="province" role="combobox">
          <span class="ant-select-selection-item" title="陕西">陕西</span>
          <input class="ant-select-search__field" placeholder="省份" />
        </div>
        <div id="city" role="combobox">
          <span class="ant-select-selection-item" title="西安">西安</span>
          <input class="ant-select-search__field" placeholder="城市/景区" />
        </div>
        <div id="spot" role="combobox">
          <span class="ant-select-selection-item" title="西安明城墙">西安明城墙</span>
          <input class="ant-select-search__field" placeholder="景点" />
        </div>
        <button type="button" id="add">添加</button>
      </div>
      <div class="ant-select-dropdown ant-select-dropdown-hidden">
        <div class="ant-select-item-option">西安城墙</div>
      </div>
      <script>
        window.scenicEvents = [];
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => window.scenicEvents.push('click:' + box.id));
          box.querySelector('input').addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('#add').addEventListener('click', () => window.scenicEvents.push('add'));
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["西安城墙"], logs);
    const events = await page.evaluate(() => (window as any).scenicEvents as string[]);
    assert.ok(!events.some((event) => event.startsWith("click:")), "不得触发 combobox 点击");
    assert.ok(!events.some((event) => event.startsWith("input:")), "不得触发 combobox 搜索输入");
    assert.ok(!events.includes("add"), "不得点击添加按钮");
    assert.ok(logs.some((log) => log.includes("西安城墙") && log.includes("已存在")), "logs 必须包含已存在提示");
  } finally {
    await browser.close();
  }
});

test("fillServicePhone 存在且严格精确匹配、不默认第一项", async () => {
  const source = readCtripSource();
  assert.match(source, /async function fillServicePhone\(/);
  // 禁止 .first() / .nth(0) 逃避，必须用严格相等的精确匹配。
  const start = source.indexOf("async function fillServicePhone(");
  assert.ok(start >= 0, "找不到 fillServicePhone 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.match(body, /label\[for=\\"baseInfo\.phone400\\"\]/, "必须使用 VBK 真实的 400 电话字段 ID");
  assert.ok(/text === target/.test(body), "fillServicePhone 必须用严格相等精确匹配");
  assert.ok(/matchIndex\s*<\s*0/.test(body), "fillServicePhone 未命中必须抛错");
  // 在「收集选项文本」之后到「点选」之前，禁掉任何 .first()/.nth(0) 偷懒写法。
  const collectAnchor = body.indexOf("await options.allTextContents()");
  assert.ok(collectAnchor > 0, "找不到 fillServicePhone 的选项收集调用");
  const clickAnchor = body.indexOf("await options.nth(matchIndex).click()");
  assert.ok(clickAnchor > collectAnchor, "找不到 fillServicePhone 的精确点击");
  const region = body.slice(collectAnchor, clickAnchor);
  assert.ok(!/\.first\(/.test(region), "fillServicePhone 在收集-点选之间出现 .first()");
  assert.ok(!/\.nth\(0\)/.test(region), "fillServicePhone 在收集-点选之间出现 .nth(0)");
});

test("fillScenicAreaSpots 存在并以严格相等匹配、不默认第一项", async () => {
  const source = readCtripSource();
  assert.match(source, /async function fillScenicAreaSpots\(/);
  const start = source.indexOf("async function fillScenicAreaSpots(");
  assert.ok(start >= 0, "找不到 fillScenicAreaSpots 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.match(body, /chooseExact\(comboboxes\.nth\(3\), spot/);
  assert.match(body, /chooseExact\(comboboxes\.nth\(2\), spot/);
  assert.match(body, /aliases\.includes\(text\)/, "fillScenicAreaSpots 必须用可控别名精确匹配");
  assert.match(body, /options\.nth\(index\)\.innerText/);
  assert.match(body, /景点“\$\{spot\}”已选择但未成功添加/);
  assert.match(body, /await combobox\.click\(\)/);
  // 数据风险弹窗必须能跳过该景点，遵用户指示“遇到数据风险就跳过该景点”。
  assert.match(body, /dismissDataRiskDialog/);
  assert.match(body, /数据风险弹窗.*跳过该景点/);
  assert.doesNotMatch(body, /combobox\.locator\("\.ant-select-selection"\)/);
  assert.doesNotMatch(body, /type\("中国"/);
  assert.doesNotMatch(body, /chooseExact\(comboboxes\.nth\(1\)/, "国内景点无需重复选择省份");
  assert.doesNotMatch(body, /cityLabel/);
  assert.ok(/logs\.push/.test(body), "fillScenicAreaSpots 未命中必须记录日志");
  assert.doesNotMatch(body, /options\.(?:first|nth\(0\))/, "禁止默认第一项");
});

test("fillLocalTravelAgency 重试时清空旧值且只保留第一个地接社", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillLocalTravelAgency");
  const end = source.indexOf("\nasync function fillButlerContact", start);
  const body = source.slice(start, end);
  assert.match(body, /ant-select-selection__choice__remove/);
  assert.match(body, /remove\.click\(\{ force: true \}\)/);
  assert.match(body, /searchInput\.click\(\)/);
  assert.match(body, /findFirstEnabledOptionIndex/);
  assert.match(body, /selectedChoices\.count\(\)\) !== 1/);
  assert.match(body, /committedText\.includes\(texts\[targetIndex\]\)/);
});

// pickCityOption 是 fillCitySelect 拆出来的纯函数，下面用真实 bug 场景锁定
// 行为：国内行程优先“中国-大同”，明确指定 preferredCountry="中国" 时绝不能
// 回退到“朝鲜-大同”，未指定时多国同名要报歧义。

test("pickCityOption 指定中国时优先匹配中国-大同，不回退到朝鲜-大同", () => {
  const labels = ["朝鲜-大同", "中国-大同"];
  const result = pickCityOption(labels, "大同", "中国");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "中国-大同");
  assert.equal(result.kind === "matched" && result.index, 1);
});

test("pickCityOption 指定中国时遇到朝鲜-大同不能算命中", () => {
  const labels = ["朝鲜-大同"];
  const result = pickCityOption(labels, "大同", "中国");
  assert.equal(result.kind, "missing");
  assert.equal(result.kind === "missing" && result.reason, "wrongCountry");
  assert.deepEqual(result.kind === "missing" && result.seen, ["朝鲜-大同"]);
});

test("pickCityOption 未指定国家时多个同名候选要报歧义而非默认第一项", () => {
  const labels = ["朝鲜-大同", "中国-大同"];
  const result = pickCityOption(labels, "大同");
  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.kind === "ambiguous" && result.labels, ["朝鲜-大同", "中国-大同"]);
});

test("pickCityOption 未指定国家时唯一候选精确命中", () => {
  const labels = ["中国-大同"];
  const result = pickCityOption(labels, "大同");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "中国-大同");
  assert.equal(result.kind === "matched" && result.index, 0);
});

test("pickCityOption 未指定国家时裸城市名作为唯一候选也允许命中", () => {
  const result = pickCityOption(["大同"], "大同");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "大同");
});

test("pickCityOption 找不到候选返回 notFound 并保留所有可见项", () => {
  const labels = ["中国-太原", "中国-临汾"];
  const result = pickCityOption(labels, "大同");
  assert.equal(result.kind, "missing");
  assert.equal(result.kind === "missing" && result.reason, "notFound");
  assert.deepEqual(result.kind === "missing" && result.seen, ["中国-太原", "中国-临汾"]);
});

test("pickCityOption 指定中国时同国家多个同名项要报歧义", () => {
  const result = pickCityOption(["中国-大同", "中国-大同"], "大同", "中国");
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.kind === "ambiguous" && result.labels.length, 2);
});

test("fillCitySelect 幂等判断：朝鲜-大同已选时在指定中国下必须重新打开下拉", async () => {
  // 用源码断言：原 endsWith 判等已删除，幂等分支必须调用 pickCityOption 并
  // 把 preferredCountry 一并传入；这样“朝鲜-大同”不会让中国行程被误认为已选。
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  // 幂等判断那一步必须把 selectedText 包进数组喂给 pickCityOption，且带上
  // preferredCountry；缺一会让 endsWith 旧逻辑残留。
  assert.match(body, /pickCityOption\(\[selectedText\], city, preferredCountry\)/);
  assert.ok(!/selectedText\.endsWith/.test(body), "幂等分支不能再用 endsWith 直接命中");
});

test("fillBasicInfo 在省份非空时给两处城市都传中国，且 fallback 行为受控", async () => {
  const source = readCtripSource();
  const start = source.indexOf("export async function fillBasicInfo");
  const end = source.indexOf("\nasync function fillScenicAreaProvince", start);
  const body = source.slice(start, end);
  // 两处 fillCitySelect 必须都拿到 preferredCountry 形参（由 info.province 派生）。
  // 后期会追加 5th 参数（AI 上下文）；这里只检查形参出现，不限位。
  const matches = body.match(/fillCitySelect\([^)]+\)/g) || [];
  assert.ok(matches.length >= 2, "fillBasicInfo 必须调用 fillCitySelect 至少两次");
  for (const call of matches) {
    assert.match(
      call,
      /,\s*preferredCountry\b/,
      `fillCitySelect 必须显式传 preferredCountry 形参：${call}`,
    );
  }
  // 没有省份时不允许静默传 "中国"，应该传 undefined 让 pickCityOption 走老路径。
  assert.match(body, /info\.province\s*&&\s*info\.province\.trim\(\)\s*\?\s*"中国"\s*:\s*undefined/);
});

test("clickSection 目标 tab 已激活时直接返回，避免 loading 遮罩下重复点击超时", async () => {
  const ctrip = readCtripSource();
  const body = helperBody(
    ctrip,
    "async function clickSection(",
    "\nasync function waitForSectionEnabled(",
  );
  assert.match(body, /getAttribute\("aria-selected"\).*=== "true"/);
  assert.match(body, /ant-tabs-tab-active/);
  const activeGuard = body.indexOf("if (selected ||");
  const click = body.indexOf("await current.click()", activeGuard);
  assert.ok(activeGuard >= 0 && click > activeGuard, "active tab guard 必须位于 click 之前");
  assert.match(
    body.slice(activeGuard, click),
    /return/,
    "目标 tab 已 active 时必须直接返回，不能重复点击",
  );
});

// —— 通用 save-then-advance helper 的回归锁 ——————
// 真实 VBK baseInfoMerge 页面同时存在白色「保存」和蓝色「下一步」两个提
// 交流入口；只有「下一步」会真正解锁下一个 tab。本批测试负责锁死新通用
// helper 的契约：精确唯一「下一步」按钮，禁止「提交审核并下一步」前缀
// 误命中，两种成功门禁（URL 已落点 / tab 解锁），失败门禁给出明确错误，
// 严格不调用 submitCurrentSectionAndNext、不触碰提审/发布/价格库存。

test("saveThenAdvance 是 ctrip.ts 内的通用 helper，禁止 clickBasicInfoNextStep/classifyBasicInfoSaveOutcome 残留", async () => {
  const ctrip = readCtripSource();
  // 通用 helper 必须存在。
  assert.match(ctrip, /async function saveThenAdvance\(/);
  // basic-only 的 clickBasicInfoNextStep / classifyBasicInfoSaveOutcome
  // 已删除（被 saveThenAdvance 与 isProductImageTextUrl 替代）。
  assert.doesNotMatch(
    ctrip,
    /async function clickBasicInfoNextStep/,
    "clickBasicInfoNextStep 已合并到 saveThenAdvance，禁止再单独存在",
  );
  assert.doesNotMatch(
    ctrip,
    /export function classifyBasicInfoSaveOutcome/,
    "classifyBasicInfoSaveOutcome 已并入 saveThenAdvance 内的 isTargetUrl，禁止再单独存在",
  );
});

test("saveThenAdvance 精确 role=button name=下一步 exact=true 且要求唯一可见 enabled", async () => {
  const ctrip = readCtripSource();
  const body = helperBody(
    ctrip,
    "async function saveThenAdvance(",
    "\nasync function findUnlockedSectionLabel",
  );
  // 精确定位规则：role=button + name=下一步 + exact=true（nextButtonLabel 默认值）。
  assert.match(body, /page\.getByRole\("button", \{ name: nextButtonLabel, exact: true \}\)/);
  // 唯一性断言：count !== 1 直接抛错。
  assert.match(body, /if \(count !== 1\)/);
  // 错误必须带阶段 / 观测 URL / 目标 tab 三类上下文。
  assert.match(body, /phase/);
  assert.match(body, /targetTabLabel/);
  assert.match(body, /观测 URL=/);
  assert.match(body, /目标 tab=/);
  // 必须检查可见 / enabled / aria-disabled；缺一会让旧 bug 复发。
  assert.match(body, /!\(await button\.isVisible\(\)\)/);
  assert.match(body, /!\(\(await button\.isEnabled\(\)\) \?\? true\)/);
  assert.match(body, /aria-disabled.*true/);
});

test("saveThenAdvance 禁止匹配「提交审核并下一步」并禁止调用 submitCurrentSectionAndNext", async () => {
  const ctrip = readCtripSource();
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 只看实现代码不看注释：把 // 开头的注释整段删掉再断言。
  const codeOnly = stripComments(helper);
  assert.ok(
    !codeOnly.includes("提交审核并下一步"),
    "saveThenAdvance 实现中禁止匹配「提交审核并下一步」",
  );
  assert.ok(
    !codeOnly.includes("submitCurrentSectionAndNext"),
    "saveThenAdvance 必须不调用 submitCurrentSectionAndNext",
  );
  // 「提交审核并下一步」是已存在的提审入口，源码里仍存在但 helper 不得引用。
  assert.match(ctrip, /async function submitCurrentSectionAndNext\(/);
});

test("saveThenAdvance 点击后处理「保存成功」提示并点我知道了/知道了/确定", async () => {
  const ctrip = readCtripSource();
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 必须依赖 dismissKnownNoticeDialogs 的保存成功分支。
  assert.match(helper, /dismissKnownNoticeDialogs\(page, \{ waitForSaveSuccess: true \}\)/);
  // dismissKnownNoticeDialogs 内部必须能识别「保存成功」并点确认按钮。
  const dialogBody = helperBody(
    ctrip,
    "async function dismissKnownNoticeDialogs",
    "\nasync function submitCurrentSectionAndNext",
  );
  assert.match(dialogBody, /我知道了\|知道了\|确 定\|确定/);
});

test("saveThenAdvance 失败门禁：未跳转且未解锁时报明确错误，且带阶段/目标/观测 URL/目标 tab 上下文", async () => {
  const ctrip = readCtripSource();
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 失败错误必须包含「阶段点击…后未到达目标…：URL=…目标 tab 仍未解锁」
  // 的上下文（阶段名、目标 tab、观测 URL、目标 tab 未解锁说明）。
  assert.match(helper, /\$\{phase\}点击/);
  assert.match(helper, /未到达目标「\$\{targetTabLabel\}」/);
  assert.match(helper, /URL=\$\{observedUrl\}/);
  assert.match(helper, /目标 tab 仍未解锁/);
});

test("saveThenAdvance 跳页命中后立刻返回，不再二次点 tab", async () => {
  const ctrip = readCtripSource();
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 已跳转分支（`if (navigated)` → return）到 tabUnlocked 分支之间，
  // 不允许出现任何 clickSection 调用。
  const navigatedAnchor = helper.indexOf("if (navigated)");
  assert.ok(navigatedAnchor >= 0, "saveThenAdvance 必须存在 navigated 分支");
  const navigatedBlock = helper.slice(
    navigatedAnchor,
    helper.indexOf("if (unlockedLabel)", navigatedAnchor),
  );
  assert.doesNotMatch(navigatedBlock, /clickSection/, "已跳转分支不允许再点 tab");
});

