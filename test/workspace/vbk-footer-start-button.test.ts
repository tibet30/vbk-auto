/**
 * VBK 录入「开始/停止自动录入」按钮位置回归契约。
 *
 * 背景：原先顶部栏承载 VBK 录入主操作（保存草稿按钮），后端启动/停止逻辑
 * 散落在两个文件里。本次重构要求把主操作迁移到 VBK 录入页左面板 footer 的
 * 底部左侧，并把启动按钮文案统一为「开始自动录入」；同时顶部栏不得再渲染
 * 该主操作或重复入口（停止/登录/账户控件行为不被破坏）。
 *
 * 仓库 test infra 是 `node:test + tsx`，没有任何 React Testing Library / jsdom。
 * 因此这里以静态源码契约锁定本回归要点，而不是真正驱动 React reconciler：
 *  - vbk.tsx 左面板 footer 的底部左侧有「开始自动录入」主按钮（静态文本、
 *    aria-label、title 都为「开始自动录入」），其 onClick 在 stage !== "vbk"
 *    时先调 setStage("vbk")，再调用原 startAutomation；
 *  - 该按钮的 disabled 必须由 readiness.ready 与 loading 共同决定；
 *  - 当 automationActive 时，同一槽位显示「停止自动录入」按钮，disabled
 *    与 busy 状态由 stoppingAutomation 驱动；
 *  - Topbar.tsx 不再渲染任何「保存草稿 / 开始自动录入 / 重新开始一轮保存」
 *    主操作按钮，登录态、当前账号、停止自动录入、账户控件相关字段未被
 *    错误清理。
 *
 * 验收门 1～4 全部由本测试 + npm run check 联合兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

const vbkSrc = read("src/renderer/app/views/workspace/vbk.tsx");
const vbkLessSrc = read("src/renderer/app/views/workspace/vbk.module.less");
const topbarSrc = read("src/renderer/app/views/shell/Topbar.tsx");
const workflowSrc = read("src/renderer/app/actions/workflow.ts");

/**
 * 抽出 productFooter 区块（<footer ...> ... </footer> 内部），锁定 footer 形态。
 * 该方法使用字符串扫描，仅在测试本文件对 vbk.tsx 的最新布局有效；布局变更
 * 时本测试会失败并提醒。
 */
function extractProductFooter(source: string): string {
  const footerStart = source.indexOf("<footer");
  assert.ok(footerStart >= 0, "vbk.tsx 必须存在 <footer ...> 块（vbk 页左面板 footer）");
  const footerEnd = source.indexOf("</footer>", footerStart);
  assert.ok(footerEnd > footerStart, "vbk.tsx footer 块未闭合");
  return source.slice(footerStart, footerEnd);
}

test("VBK footer: 底部左侧有「开始自动录入」主按钮，文案/aria-label/title 完全一致", () => {
  const footer = extractProductFooter(vbkSrc);

  // 关键不变量：button 文本必须出现两次（button children 文本 + 隐含于 aria-label/title）。
  // 这里要求显式 button 标签、aria-label、title 三处全部为「开始自动录入」。
  // 实际源码中 button 体内还有 <Play /> 图标 + 换行 + 文本，regex 用 [\s\S] 宽松匹配。
  const buttonBlock = footer.match(
    /aria-label="开始自动录入"[\s\S]*?title="开始自动录入"[\s\S]*?<Play[\s\S]*?开始自动录入[\s\S]*?<\/button>/,
  );
  assert.ok(
    buttonBlock,
    "VBK footer 必须存在一个按钮：aria-label='开始自动录入'，title='开始自动录入'，"
    + "button 文本也为'开始自动录入'，作为左面板 footer 底部左侧的主操作。",
  );

  // 文本必须为「开始自动录入」，不允许再出现「保存草稿 / 重新开始一轮保存」作为按钮文案。
  assert.doesNotMatch(
    footer,
    />\s*保存草稿\s*<\/button>/,
    "VBK footer 不允许出现 '保存草稿' 按钮文案；必须统一为 '开始自动录入'。",
  );
  assert.doesNotMatch(
    footer,
    />\s*重新开始一轮保存\s*<\/button>/,
    "VBK footer 不允许出现 '重新开始一轮保存' 按钮文案；必须统一为 '开始自动录入'。",
  );

  // 按钮必须位于 productFooterActions 这个左侧槽位内；即视觉上 footer 底部左侧。
  // 简化校验：buttonBlock 索引必须早于 productFooterMeta 索引（meta 还在右侧）。
  const actionsIdx = footer.indexOf("productFooterActions");
  const metaIdx = footer.indexOf("productFooterMeta");
  assert.ok(actionsIdx >= 0 && metaIdx >= 0, "footer 必须同时存在 productFooterActions 与 productFooterMeta 槽位");
  assert.ok(
    buttonBlock!.index < metaIdx,
    "「开始自动录入」按钮必须位于 productFooterActions 槽位（左），而 productFooterMeta 在其右侧。",
  );
});

test("VBK footer: 「开始自动录入」按钮在 stage !== 'vbk' 时切 stage 后调用 startAutomation", () => {
  const footer = extractProductFooter(vbkSrc);

  // 找到「开始自动录入」按钮（以 aria-label 锚点），向前回溯到该 button 的 <button，
  // 向后扫描到下一个 </button>，再在该 button 块内提取 onClick。
  const ariaIdx = footer.indexOf('aria-label="开始自动录入"');
  assert.ok(ariaIdx >= 0, "无法定位「开始自动录入」按钮的 aria-label");
  const beforeButton = footer.lastIndexOf("<button", ariaIdx);
  assert.ok(beforeButton >= 0, "无法定位「开始自动录入」按钮的 <button 起始");
  const afterButton = footer.indexOf("</button>", ariaIdx);
  assert.ok(afterButton >= 0, "无法定位「开始自动录入」按钮的 </button>");
  const buttonSlice = footer.slice(beforeButton, afterButton);

  const onClickMatch = buttonSlice.match(/onClick=\{([\s\S]*?)\}/);
  assert.ok(onClickMatch, "无法定位「开始自动录入」按钮的 onClick");
  const onClickBody = onClickMatch![1];

  // onClick 行为契约：先 setStage("vbk")，再 void startAutomation()。
  assert.match(
    onClickBody,
    /if\s*\(\s*stage\s*!==\s*"vbk"\s*\)\s*setStage\(\s*"vbk"\s*\)/,
    "点击「开始自动录入」时必须在 stage !== 'vbk' 时调用 setStage('vbk')，保持 VBK stage。",
  );
  assert.match(
    onClickBody,
    /void\s+startAutomation\(\)/,
    "点击「开始自动录入」必须调用原 startAutomation 行为（void startAutomation()）。",
  );

  // onClick 内 setStage("vbk") 必须在 startAutomation() 之前出现，确保 stage 先切。
  const setStageIdx = onClickBody.indexOf('setStage("vbk")');
  const startIdx = onClickBody.indexOf("startAutomation()");
  assert.ok(setStageIdx >= 0 && startIdx >= 0, "onClick 体中 setStage / startAutomation 必须存在");
  assert.ok(
    setStageIdx < startIdx,
    "setStage('vbk') 必须在 startAutomation() 之前执行，避免 VBK stage 未切就触发主进程。",
  );
});

test("VBK footer: 「开始自动录入」按钮 disabled 由 readiness.ready 与 loading 决定", () => {
  const footer = extractProductFooter(vbkSrc);

  // 抽取「开始自动录入」按钮的 disabled 表达式。
  // 真实源码顺序：disabled -> aria-label（disabled 在 aria-label 之前）。
  // 因此先定位 aria-label 锚点，再向 disabled 方向回溯到 button 起始。
  const ariaIdx = footer.indexOf('aria-label="开始自动录入"');
  assert.ok(ariaIdx >= 0, "无法定位「开始自动录入」按钮的 aria-label");
  // 找「开始自动录入」按钮所在的 <button 起始位置。
  const beforeButton = footer.lastIndexOf("<button", ariaIdx);
  assert.ok(beforeButton >= 0, "无法定位「开始自动录入」按钮的 <button 起始");
  // 找 button 结束位置：从 ariaIdx 向后扫描到第一个 </button>。
  const afterButton = footer.indexOf("</button>", ariaIdx);
  assert.ok(afterButton >= 0, "无法定位「开始自动录入」按钮的 </button>");
  const buttonSlice = footer.slice(beforeButton, afterButton);

  const disabledMatch = buttonSlice.match(/disabled=\{([\s\S]*?)\}/);
  assert.ok(disabledMatch, "无法定位「开始自动录入」按钮的 disabled 表达式");
  const disabledExpr = disabledMatch![1];

  // readiness.ready 与 loading 都必须出现在 disabled 表达式中（即与原 Topbar 一致）。
  assert.match(
    disabledExpr,
    /!\s*readiness\.ready/,
    "「开始自动录入」按钮的 disabled 必须包含 !readiness.ready，未就绪时禁用。",
  );
  assert.match(
    disabledExpr,
    /\|\|\s*loading/,
    "「开始自动录入」按钮的 disabled 必须包含 loading，避免与运行态重叠。",
  );
});

test("VBK footer: automationActive 时同槽位渲染「停止自动录入」按钮，busy 状态由 stoppingAutomation 决定", () => {
  const footer = extractProductFooter(vbkSrc);

  // 1) 渲染分支契约：当 automationActive 时，footer 必须显示「停止自动录入」按钮。
  //    真实源码：停止按钮体内还有 <LoaderCircle / Square /> + 换行 + 文本。
  //    用 aria-label 锚定整个 button 块。
  const stopAriaIdx = footer.indexOf('aria-label="停止自动录入"');
  assert.ok(stopAriaIdx >= 0, "VBK footer 必须存在 aria-label='停止自动录入' 的按钮");
  const stopButtonStart = footer.lastIndexOf("<button", stopAriaIdx);
  const stopButtonEnd = footer.indexOf("</button>", stopAriaIdx) + "</button>".length;
  const stopButton = footer.slice(stopButtonStart, stopButtonEnd);
  assert.match(
    stopButton,
    /停止自动录入/,
    "VBK footer 的「停止自动录入」按钮块必须包含 '停止自动录入' 文案。",
  );

  // 2) 三元契约：footer 的「停止 / 开始」渲染必须由 automationActive 决定。
  assert.match(
    footer,
    /automationActive\s*\?\s*\([\s\S]*?停止自动录入[\s\S]*?\)\s*:\s*\([\s\S]*?开始自动录入[\s\S]*?\)/,
    "VBK footer 必须用 `automationActive ? 停止按钮 : 开始按钮` 的三元分支，"
    + "确保 active 时只渲染停止，未启动时只渲染开始，不会出现两个按钮同时显示。",
  );

  // 3) 停止按钮的 disabled 与 busy 必须由 stoppingAutomation 决定。
  const stopDisabled = stopButton.match(/disabled=\{([\s\S]*?)\}/);
  assert.ok(stopDisabled, "停止按钮必须存在 disabled 表达式");
  assert.match(
    stopDisabled![1],
    /stoppingAutomation/,
    "停止按钮的 disabled 必须来自 stoppingAutomation，确保正在停止时不会再触发。",
  );
  assert.match(
    stopButton,
    /data-busy=\{stoppingAutomation\}/,
    "停止按钮必须有 data-busy={stoppingAutomation}，方便 e2e 与样式侧区分忙碌态。",
  );
});

test("VBK footer: productFooter CSS 仍为 space-between，把 actions 槽位锚定到底部左侧", () => {
  // 不变更 productFooter 布局的情况下，actions 槽位需要被推到左、meta 槽位到右。
  // 这里锁定关键 CSS 形态：flex + space-between + actions 槽位仍存在。
  assert.match(
    vbkLessSrc,
    /\.productFooter\s*\{[\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/,
    "vbk.module.less 中 .productFooter 仍应为 flex + space-between 布局，"
    + "保证 actions 槽位（先渲染）被锚定到左、meta 槽位（后渲染）被推到右。",
  );
  assert.match(
    vbkLessSrc,
    /\.productFooterActions\s*\{[\s\S]*?display:\s*inline-flex/,
    "vbk.module.less 必须保留 .productFooterActions 样式（actions 槽位锚定）。",
  );
});

test("Topbar: 不再渲染「保存草稿 / 开始自动录入 / 重新开始一轮保存」主操作按钮", () => {
  // 1) 顶部栏按钮区（topbarToolRail）必须只保留账户控件，不再出现启动 / 停止按钮。
  const topbarRailMatch = topbarSrc.match(/topbarToolRail[\s\S]*?<\/div>/);
  assert.ok(topbarRailMatch, "Topbar 必须存在 topbarToolRail 槽位");
  const rail = topbarRailMatch![0];

  // 启动 / 保存草稿 / 重新开始一轮保存 文案都不应再出现。
  assert.doesNotMatch(
    rail,
    /开始自动录入/,
    "Topbar topbarToolRail 槽位不应再出现 '开始自动录入' 按钮。",
  );
  assert.doesNotMatch(
    rail,
    />\s*保存草稿\s*</,
    "Topbar topbarToolRail 槽位不应再出现 '保存草稿' 按钮。",
  );
  assert.doesNotMatch(
    rail,
    />\s*重新开始一轮保存\s*</,
    "Topbar topbarToolRail 槽位不应再出现 '重新开始一轮保存' 按钮。",
  );

  // 顶部栏整文件层面也不允许再渲染这三个按钮文案（防止后面又把按钮加回来）。
  assert.doesNotMatch(
    topbarSrc,
    /aria-label="保存草稿"/,
    "Topbar.tsx 不应再渲染 aria-label='保存草稿' 的按钮。",
  );
  assert.doesNotMatch(
    topbarSrc,
    /aria-label="开始自动录入"/,
    "Topbar.tsx 不应再渲染 aria-label='开始自动录入' 的按钮。",
  );
  assert.doesNotMatch(
    topbarSrc,
    /aria-label="停止自动录入"/,
    "Topbar.tsx 不应再渲染 aria-label='停止自动录入' 的按钮（停止入口统一在 VBK footer 左下）。",
  );

  // 2) 关键字段：saveDraftLabel、startAutomation、stopAutomation 不再被 Topbar 解构使用。
  //    （这些字段仍由 model 暴露，但 Topbar 不再消费它们；这一条是预防性回归锁。）
  assert.doesNotMatch(
    topbarSrc,
    /\bsaveDraftLabel\b/,
    "Topbar.tsx 不应再解构或使用 saveDraftLabel 字段（来自 state/derived.ts）。",
  );
  assert.doesNotMatch(
    topbarSrc,
    /\bstartAutomation\b/,
    "Topbar.tsx 不应再解构或调用 startAutomation（主操作已迁移）。",
  );
  assert.doesNotMatch(
    topbarSrc,
    /\bstopAutomation\b/,
    "Topbar.tsx 不应再解构或调用 stopAutomation（停止入口已统一在 VBK footer 左下）。",
  );
});

test("Topbar: 登录态 / 账户控件 / 浏览器启停相关的 model 字段未被错误清理", () => {
  // 这些是验收门 2 里「登录状态、停止自动录入及账户控件行为不被破坏」的间接保证：
  // 即 topbar 仍能消费登录态 + 账号菜单需要的字段，没有把整个 model 误删。
  for (const required of [
    "currentAccountName",
    "accountInitial",
    "vbkLogin",
    "openLogin",
    "logoutVbk",
    "checkingVbkLogin",
    "accountMenuOpen",
    "setAccountMenuOpen",
  ]) {
    assert.ok(
      topbarSrc.includes(required),
      `Topbar.tsx 必须继续消费 model 字段 ${required}，否则登录/账户控件会失能。`,
    );
  }
  // AccountPopover 仍由 Topbar 渲染，确保账号菜单可点开。
  assert.match(
    topbarSrc,
    /<AccountPopover[\s\S]*?savedAccounts=\{model\.vbkLoginAccounts\?\.saved\s*\?\?\s*\[\]\}/,
    "Topbar.tsx 必须继续把 vbkLoginAccounts.saved 透传给 AccountPopover，保证账户切换 UI 完整。",
  );
});

test("actions/workflow: startAutomation 仍负责 setStage('vbk') + automation.start，主行为契约未变", () => {
  // 验收门 1 要求「点击必须保持原有调用 startAutomation 的行为」。
  // 即 vbk.tsx 调用的是原 startAutomation，且其内部依然负责切到 vbk 阶段。
  const startMatch = workflowSrc.match(/const\s+startAutomation\s*=\s*async\s*\(\s*\)\s*=>\s*\{/);
  assert.ok(startMatch, "workflow.ts 必须保留 const startAutomation = async () => { ... }");
  const startStart = startMatch!.index! + startMatch![0].length;
  const startEnd = workflowSrc.indexOf("\n  };", startStart);
  assert.notEqual(startEnd, -1, "无法定位 startAutomation 函数体结束");
  const startBody = workflowSrc.slice(startStart, startEnd);

  assert.ok(
    startBody.includes('setStage("vbk")'),
    "startAutomation 内部必须保留 setStage('vbk')，这是它与新按钮契约的衔接点。",
  );
  assert.ok(
    startBody.includes("automation.start"),
    "startAutomation 必须继续调用 api()!.automation.start(...)；主行为不能被改写。",
  );
});
