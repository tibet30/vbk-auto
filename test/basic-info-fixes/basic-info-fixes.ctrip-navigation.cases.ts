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
import { fillServicePhone } from "../../src/main/automation/ctrip/basic-info/sections.js";

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
  const click = body.indexOf("await current.evaluate", activeGuard);
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
