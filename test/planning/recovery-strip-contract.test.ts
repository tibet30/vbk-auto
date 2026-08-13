/**
 * 方案规划恢复面板（recovery strip）renderer 源码契约测试：
 *  - review.tsx 的 conversation 区域必须在 planningRecovery 是 needs_user/failed
 *    时渲染「继续规划 / 重试规划」按钮；
 *  - 该按钮必须 invoke planning.resume（而非 legacy ai.send）；
 *  - 按钮在 running/loading 状态、重复点击场景下必须 disabled / 防重入；
 *  - planningBusy 标志位负责重复点击锁，planningResume 实现里也必须遵守；
 *  - 整个 strip 是中文：headline / hint / chip 文本都来自中文语义。
 *
 *  与 vbk-login-button-callback-stability.test.ts 一样用「源码契约」而非「真渲染测试」：
 *  仓库 test infra 是 node:test + tsx，没有 React Testing Library / jsdom；
 *  import review.tsx 会触发 window.vbk / DOM 全局垫片。这层契约足以抓住
 *  本次回归的核心修复点。
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

const reviewSrc = read("src/renderer/app/views/workspace/review.tsx");
const derivedSrc = read("src/renderer/app/state/derived.ts");

test("review.tsx 在 conversation 区域内渲染「继续规划 / 重试规划」按钮", () => {
  // 按钮文本必须同时含「继续规划」和「重试规划」两种语义：
  //   - 继续规划：needs_user
  //   - 重试规划：failed
  assert.match(reviewSrc, /继续规划/, "review.tsx 必须有「继续规划」按钮文案（needs_user 用）");
  assert.match(reviewSrc, /重试规划/, "review.tsx 必须有「重试规划」按钮文案（failed 用）");
  // 按钮必须在 conversation 区域内（与产品消息同 panel），避免被独立 panel 隐藏。
  const conversationIdx = reviewSrc.indexOf('className={chat.conversation}');
  assert.notEqual(conversationIdx, -1, "review.tsx 必须有 conversation 容器");
  const buttonsIdx = reviewSrc.indexOf('planning-resume-button');
  assert.notEqual(buttonsIdx, -1, "review.tsx 必须有 data-testid=planning-resume-button 的按钮");
  // 按钮必须出现在 conversation 容器之后、composer 之前。
  const composerIdx = reviewSrc.indexOf('className={chat.composer}');
  assert.ok(conversationIdx < buttonsIdx, "恢复按钮必须在 conversation 区域内");
  assert.ok(buttonsIdx < composerIdx, "恢复按钮必须在 composer 上方，不被覆盖在底部");
});

test("恢复按钮的 onClick 调 planningResume，且 planningResume 内部调 planning.resume（不是 ai.send）", () => {
  // review.tsx 的 onClick 必须落到 model.planningResume，而不是旧的 ai.send。
  const onClickMatch = reviewSrc.match(/onClick=\{\(\)\s*=>\s*void\s+planningResume\(\)\}/);
  assert.ok(onClickMatch, "恢复按钮的 onClick 必须 void planningResume()（避免未捕获 promise）");
  // derived.ts 的 planningResume 必须调 api().planning.resume，并显式禁止 ai.send。
  assert.match(derivedSrc, /api\(\)!\.planning\.resume\(product\.id\)/, "planningResume 必须调 planning.resume IPC");
  assert.ok(
    !/api\(\)!\.ai\.send\(/.test(derivedSrc.replace(/\/\/[^\n]*\n/g, "")),
    "planningResume 不应再调 ai.send（AI 旧入口；恢复面板只接 staged planning）"
  );
});

test("恢复按钮在 running/loading/planningBusy 时 disabled，且 planningResume 内部有重复点击守卫", () => {
  // 按钮 disabled 表达式必须显式包含 planningBusy || loading，否则
  // 点锁会失效，导致重复点击产生并发 IPC。
  const buttonOpenIdx = reviewSrc.indexOf('data-testid="planning-resume-button"');
  assert.notEqual(buttonOpenIdx, -1, "恢复按钮必须存在");
  const buttonStart = reviewSrc.lastIndexOf("<button", buttonOpenIdx);
  assert.notEqual(buttonStart, -1);
  const buttonTag = reviewSrc.slice(buttonStart, buttonOpenIdx + 200);
  const disabledMatch = buttonTag.match(/disabled=\{([^}]+)\}/);
  assert.ok(disabledMatch, "恢复按钮必须有 disabled={...} 表达式");
  const expr = disabledMatch[1];
  assert.match(
    expr,
    /planningBusy\s*\|\|\s*loading/,
    "恢复按钮 disabled 必须显式包含 planningBusy || loading；缺一项都会让 running 时按钮仍可点",
  );
  // derived.ts 的 planningResume 必须先检查 planningBusy 再 setPlanningBusy(true)，
  // 否则 React 异步提交多个事件时仍能并发进入。
  assert.match(
    derivedSrc,
    /if\s*\(\s*planningBusy\s*\)\s*return\s*;\s*\/\/[^\n]*\n\s*setPlanningBusy\(true\)/,
    "planningResume 必须先 planningBusy 检查再 setPlanningBusy(true)；防止 React 合成事件并发",
  );
});

test("恢复面板在 status=needs_user / failed 时渲染，running 时仅展示不暴露按钮", () => {
  // 必须显式判断 status 渲染；running 时按钮不能暴露，避免用户重复点击仍在跑的任务。
  // 接受两种合法的状态分支写法：
  //   1) 紧凑 || 链：planningRecovery.status === "needs_user" || ... || "running" || ...
  //   2) 嵌套三元 / 多重条件：endswith "running")
  // 只要 needs_user 与 running 在同一渲染分支即可——这是任务验收门。
  const idxNeedsUser = reviewSrc.indexOf('planningRecovery.status === "needs_user"');
  assert.notEqual(idxNeedsUser, -1, "恢复面板必须判断 needs_user");
  const sliceFromNeedsUser = reviewSrc.slice(idxNeedsUser);
  // 在 needs_user 之后同一段渲染分支内出现 "running"（说明这两个 status 都被覆盖）。
  const idxRunning = sliceFromNeedsUser.search(/planningRecovery\.status\s*===\s*?"running"/);
  assert.ok(idxRunning > 0, "needs_user 之后必须存在 running 状态分支（同一 recovery strip 内）");
  // running / pending 都不能成为可恢复按钮条件，避免用户并发启动规划。
  const buttonsIdx = reviewSrc.indexOf('data-testid="planning-resume-button"');
  const resumableStart = reviewSrc.indexOf("const planningResumable");
  const resumableEnd = reviewSrc.indexOf("const canSend", resumableStart);
  const resumableDeclaration = reviewSrc.slice(resumableStart, resumableEnd);
  assert.doesNotMatch(resumableDeclaration, /status === "running"|status === "pending"/,
    "running / pending 不得被纳入 planningResumable，否则会发生并发续跑");
  const buttonPrefix = reviewSrc.slice(Math.max(0, buttonsIdx - 500), buttonsIdx);
  assert.match(buttonPrefix, /planningResumable/, "恢复按钮必须只由 planningResumable 显示");
});

test("completed 但阶段不全时展示继续规划，真实全完成时不展示", () => {
  assert.match(reviewSrc, /const planningPartial = planningRecovery\?\.status === "completed" && !planningRecovery\.allStagesCompleted/,
    "必须将 completed 且阶段不全识别为 planningPartial");
  assert.match(reviewSrc, /const planningResumable =[\s\S]*\|\| planningPartial/,
    "恢复按钮条件必须把 planningPartial 纳入可继续规划状态");
  const buttonStart = reviewSrc.lastIndexOf("<button", reviewSrc.indexOf('data-testid="planning-resume-button"'));
  const buttonPrefix = reviewSrc.slice(Math.max(0, buttonStart - 250), buttonStart);
  assert.match(buttonPrefix, /planningResumable/, "恢复按钮必须由 planningResumable 控制，避免真实全完成状态露出按钮");
});

test("恢复面板 head / hint / chip 都是中文，与规划状态文案一致", () => {
  // 关键文案锚点必须存在，避免 UI 文案悄悄退回英文。
  assert.match(reviewSrc, /方案规划/, "headline 必须含「方案规划」");
  assert.match(reviewSrc, /已接受/, "chips 必须有「已接受」前缀");
  assert.match(reviewSrc, /缺失/, "chips 必须有「缺失」前缀");
  // notice 文案跨文件存在：derived.ts 的 planningResume 会 setNotice("正在续跑规划…")。
  assert.match(derivedSrc, /正在续跑规划/, "续跑中的 notice 文案不能改回英文");
});
