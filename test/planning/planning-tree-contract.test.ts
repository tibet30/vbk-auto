import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const tree = read("src/renderer/app/views/workspace/planning-tree.tsx");
const derived = read("src/renderer/app/state/derived.ts");
const planningActions = read("src/renderer/app/state/domains/planning-actions.ts");
const review = read("src/renderer/app/views/workspace/review.tsx");
const planningV2Ipc = read("src/main/ipc/planning-v2-ipc.ts");
const styles = read("src/renderer/app/views/workspace/planning-tree.module.less");
const confirmDialog = read("src/renderer/app/views/workspace/planning-rerun-confirm-dialog.tsx");
const confirmDialogStyles = read("src/renderer/app/views/workspace/planning-rerun-confirm-dialog.module.less");

test("stage rerun confirms invalidated data and delegates to the derived handler", () => {
  assert.doesNotMatch(tree, /window\.confirm/);
  assert.match(tree, /rerunFocusRef\.current = rerunTriggerRefs\.current\[stage\]/);
  assert.match(confirmDialog, /showModal\(\)/);
  assert.match(confirmDialog, /onCancel=\{\(event\) =>/);
  assert.match(confirmDialog, /aria-labelledby=\{TITLE_ID\}/);
  assert.match(confirmDialog, /aria-describedby=\{DESCRIPTION_ID\}/);
  assert.match(confirmDialog, /cancelRef\.current\?\.focus\(\)/);
  assert.match(confirmDialog, /returnFocusRef\.current\?\.focus\(\)/);
  assert.match(confirmDialog, /setConfirming\(true\)/);
  assert.match(confirmDialog, /将保留产品 UUID、目的地、天数、形态、供应商编号和账号固定信息/);
  assert.match(confirmDialog, /onConfirm\(\)/);
  assert.match(tree, /void onRerunMajorStage\(stage\)/);
  assert.doesNotMatch(tree, /planning\.rerunMajorStage\(/);
  assert.match(review, /onRerunMajorStage=\{planningRerunMajorStage\}/);
  assert.match(tree, /重做此阶段/);
});

test("stage rerun exposes busy/error/result notices", () => {
  assert.match(planningActions, /const planningRerunMajorStage = async/);
  assert.match(planningActions, /setPlanningRerunBusy\(stage\)/);
  assert.match(planningActions, /setPlanningState\(result\.state\)/);
  assert.match(planningActions, /setNotice\(`重做失败：\$\{message\}`\)/);
  assert.match(tree, /rerunBusy === stage\.id \? <LoaderCircle/);
  assert.match(tree, /const state = stageBusy \? "running" : majorStageState/);
  assert.match(tree, /aria-busy=\{stageBusy\}/);
  assert.doesNotMatch(tree, /stageStateSummary[^\n]*aria-live/);
  assert.match(tree, /disabled=\{Boolean\(rerunBusy\) \|\| planningBusy \|\| itineraryAdoptionBusy/);
  assert.doesNotMatch(tree, /当前进行：/);
  assert.match(derived, /\.\.\.planningActions/);
});

test("顶部活动节点提示优先使用 currentNode，并为重做阶段提供首节点 fallback", () => {
  assert.match(tree, /export function resolveActivePlanningNode/);
  assert.match(tree, /if \(plan\?\.status === "running"\) return plan\.currentNode/);
  assert.match(tree, /foundation: "skeleton"/);
  assert.match(tree, /itinerary: "spotCandidates"/);
  assert.match(tree, /completion: "copy"/);
  assert.match(tree, /const activeNode = resolveActivePlanningNode\(plan, rerunBusy\)/);
  assert.match(tree, /AI 正在生成 \$\{NODE_LABELS\[activeNode\]\}/);
  assert.match(tree, /role="status"/);
  assert.match(tree, /aria-live="polite"/);
  assert.match(tree, /aria-atomic="true"/);
  assert.match(tree, /title=\{activeNodeLabel\}/);
  assert.match(tree, /<LoaderCircle size=\{13\} className=\{styles\.spin\} aria-hidden="true" \/>/);
  assert.doesNotMatch(tree, /当前进行：/);
});

test("生成规划内容区可在内部滚动，标题栏固定", () => {
  assert.match(styles, /\.tree \{[^}]*max-height:\s*min\(46vh,\s*480px\)/s);
  assert.match(styles, /\.tree \{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.treeBody \{[^}]*overflow:\s*auto/s);
  assert.match(tree, /className=\{styles\.treeBody\}/);
});

test("treeBody 内各模块间距统一由 gap 控制", () => {
  assert.match(styles, /\.treeBody \{[^}]*gap:\s*8px/s);
  assert.match(styles, /\.treeBody \{[^}]*padding:\s*8px 0/s);
  assert.match(styles, /\.adoptionCard \{[^}]*margin:\s*0 12px/s);
  assert.match(styles, /\.adoptionError \{[^}]*margin:\s*0 12px/s);
  assert.match(styles, /\.stageList \{[^}]*padding:\s*0 12px/s);
});

test("treeBody 子模块不被压缩，整体滚动保留行程三栏", () => {
  assert.match(styles, /\.treeBody > \* \{[^}]*flex:\s*0 0 auto/s);
});

test("completed planning collapses the tree and keeps the terminal status next to the chevron", () => {
  assert.match(tree, /useEffect/);
  assert.match(tree, /if \(plan\?\.status === "completed" && !rerunBusy\) setTreeCollapsed\(true\)/);
  assert.match(tree, /const terminalStatus = plan && !activeNodeLabel/);
  assert.match(tree, /\? \{ label: overallLabel\(plan\), status: plan\.status \}/);
  assert.match(tree, /\{terminalStatus && \(/);
  assert.match(tree, /className=\{styles\.overallStatus\}/);
  assert.match(tree, /className=\{styles\.treeTrailing\}/);
  assert.ok(tree.indexOf("{terminalStatus && (") < tree.indexOf("className={styles.treeTitleChevron}"));
  assert.ok(tree.indexOf("className={styles.treeTitleMain}") < tree.indexOf("{terminalStatus && ("));
  assert.match(tree, /规划已完成，可进入产品审查/);
  assert.doesNotMatch(tree, /规划完成，已进入产品审查/);
  assert.match(styles, /\.treeTrailing \{[^}]*gap: 4px/);
  assert.match(styles, /\.overallStatus \{[^}]*justify-content: flex-end/);
  assert.match(styles, /\.overallStatus \{[^}]*text-overflow: ellipsis/);
});

test("planning v2 mutation handlers acquire the product lock before reset/update", () => {
  for (const handler of ["planning:start", "planning:rerunMajorStage"]) {
    const start = planningV2Ipc.indexOf(`ipcMain.handle("${handler}"`);
    const end = planningV2Ipc.indexOf("\n  });", start);
    assert.ok(start >= 0 && end > start, `${handler} handler must be present`);
    const body = planningV2Ipc.slice(start, end);
    assert.ok(body.indexOf("withPlanningLock(localProductId") < body.indexOf("remoteProducts.update"), `${handler} must lock before update`);
    assert.ok(body.indexOf("remoteProducts.get") > body.indexOf("withPlanningLock(localProductId"), `${handler} must read under lock`);
  }
  assert.match(planningV2Ipc, /const runBody = async/);
  assert.match(planningV2Ipc, /return runBody\(localProductId, plan\)/);
});

test("itinerary adoption runs under the same planning product lock", () => {
  assert.match(
    planningV2Ipc,
    /ipcMain\.handle\("planning:acceptItineraryAndRerunCompletion"[\s\S]*?withPlanningLock\(localProductId[\s\S]*?acceptItineraryAndRerunCompletion\(\{[\s\S]*?run: runBody[\s\S]*?\}\)/,
  );
  assert.doesNotMatch(planningV2Ipc, /acceptItineraryAndRerunCompletion\(\{[^}]*run: run\W/);
});

test("planning tree expands all major stages by default and exposes accessible controls", () => {
  assert.match(tree, /const isCollapsed = collapsed\[stage\.id\] \?\? false/);
  assert.match(tree, /aria-expanded=\{!isCollapsed\}/);
  assert.match(tree, /tabIndex=\{0\}/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /\.generationStatus/);
  assert.match(styles, /\.generationStatus > span/);
  assert.match(styles, /\.treeTitleMain > strong/);
  assert.match(confirmDialogStyles, /\.dialog::backdrop/);
  assert.match(confirmDialogStyles, /prefers-reduced-motion/);
  assert.match(confirmDialogStyles, /overflow-wrap: anywhere/);
});

test("login block, AI failure and node status have distinct operator-facing text", () => {
  assert.match(tree, /登录恢复后可从此处继续，不消耗业务尝试次数/);
  assert.match(tree, /校验未通过，可查看错误后继续或重做阶段/);
  assert.match(tree, /被阻塞/);
  assert.match(tree, /未通过/);
});
