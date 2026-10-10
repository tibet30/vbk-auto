import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const tree = read("src/renderer/app/views/workspace/planning-tree.tsx");
const treeComponent = read("src/renderer/app/views/workspace/planning-tree/component.tsx");
const treeConstants = read("src/renderer/app/views/workspace/planning-tree/constants.ts");
const treeHelpers = read("src/renderer/app/views/workspace/planning-tree/helpers.tsx");
const treeFull = tree + '\n' + treeComponent + '\n' + treeConstants + '\n' + treeHelpers;
const derived = read("src/renderer/app/state/derived.ts");
const planningActions = read("src/renderer/app/state/domains/planning-actions.ts");
const review = read("src/renderer/app/views/workspace/review.tsx");
const planningV2Ipc = read("src/main/ipc/planning-v2-ipc.ts");
const styles = read("src/renderer/app/views/workspace/planning-tree.module.less");
const confirmDialog = read("src/renderer/app/views/workspace/planning-rerun-confirm-dialog.tsx");
const confirmDialogStyles = read("src/renderer/app/views/workspace/planning-rerun-confirm-dialog.module.less");

test("legacy stage rerun remains safe while the review uses Agent conversation", () => {
  assert.doesNotMatch(treeFull, /window\.confirm/);
  assert.match(treeFull, /rerunFocusRef\.current = rerunTriggerRefs\.current\[stage\]/);
  assert.match(confirmDialog, /showModal\(\)/);
  assert.match(confirmDialog, /onCancel=\{\(event\) =>/);
  assert.match(confirmDialog, /aria-labelledby=\{TITLE_ID\}/);
  assert.match(confirmDialog, /aria-describedby=\{DESCRIPTION_ID\}/);
  assert.match(confirmDialog, /cancelRef\.current\?\.focus\(\)/);
  assert.match(confirmDialog, /returnFocusRef\.current\?\.focus\(\)/);
  assert.match(confirmDialog, /setConfirming\(true\)/);
  assert.match(confirmDialog, /将保留产品 UUID、目的地、天数、形态、供应商编号和账号固定信息/);
  assert.match(confirmDialog, /onConfirm\(\)/);
  assert.match(treeFull, /void onRerunMajorStage\(stage\)/);
  assert.doesNotMatch(treeFull, /planning\.rerunMajorStage\(/);
  assert.match(review, /<AgentConversation/);
  assert.doesNotMatch(review, /onRerunMajorStage=\{planningRerunMajorStage\}/);
  assert.match(treeFull, /重做此阶段/);
});

test("stage rerun exposes busy/error/result notices", () => {
  assert.match(planningActions, /const planningRerunMajorStage = async/);
  assert.match(planningActions, /setPlanningRerunBusy\(stage\)/);
  assert.match(planningActions, /setPlanningState\(result\.state\)/);
  assert.match(planningActions, /setNotice\(`重做失败：\$\{message\}`\)/);
  assert.match(treeFull, /rerunBusy === stage\.id \? <LoaderCircle/);
  assert.match(treeFull, /const state = stageBusy \? "running" : majorStageState/);
  assert.match(treeFull, /aria-busy=\{stageBusy\}/);
  assert.doesNotMatch(treeFull, /stageStateSummary[^\n]*aria-live/);
  assert.match(treeFull, /disabled=\{Boolean\(rerunBusy\) \|\| planningBusy \|\| itineraryAdoptionBusy/);
  assert.doesNotMatch(treeFull, /当前进行：/);
  assert.match(derived, /\.\.\.planningActions/);
});

test("顶部活动节点提示优先使用 currentNode，并为重做阶段提供首节点 fallback", () => {
  assert.match(treeFull, /export function resolveActivePlanningNode/);
  assert.match(treeFull, /if \(plan\?\.status === "running"\) return plan\.currentNode/);
  assert.match(treeFull, /foundation: "skeleton"/);
  assert.match(treeFull, /itinerary: "spotCandidates"/);
  assert.match(treeFull, /completion: "copy"/);
  assert.match(treeFull, /const activeNode = resolveActivePlanningNode\(plan, rerunBusy\)/);
  assert.match(treeFull, /AI 正在生成 \$\{NODE_LABELS\[activeNode\]\}/);
  assert.match(treeFull, /role="status"/);
  assert.match(treeFull, /aria-live="polite"/);
  assert.match(treeFull, /aria-atomic="true"/);
  assert.match(treeFull, /title=\{activeNodeLabel\}/);
  assert.match(treeFull, /<LoaderCircle size=\{13\} className=\{styles\.spin\} aria-hidden="true" \/>/);
  assert.doesNotMatch(treeFull, /当前进行：/);
});

test("生成规划内容区可在内部滚动，标题栏固定", () => {
  assert.match(styles, /\.tree \{[^}]*max-height:\s*min\(46vh,\s*480px\)/s);
  assert.match(styles, /\.tree \{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.treeBody \{[^}]*overflow:\s*auto/s);
  assert.match(treeFull, /className=\{styles\.treeBody\}/);
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

test("completed planning collapses the tree and keeps its status in the compact header", () => {
  assert.match(treeFull, /useEffect/);
  assert.match(treeFull, /if \(plan\?\.status === "completed" && !rerunBusy\) setTreeCollapsed\(true\)/);
  assert.match(treeFull, /const terminalStatus = plan && !activeNodeLabel/);
  assert.match(treeFull, /\? \{ label: overallLabel\(plan\), status: plan\.status \}/);
  assert.match(treeFull, /workflowTask \? <WorkflowTaskSummary task=\{workflowTask\} \/> : terminalStatus && \(/);
  assert.match(treeFull, /className=\{styles\.overallStatus\}/);
  assert.match(treeFull, /className=\{styles\.treeTrailing\}/);
  assert.ok(treeFull.indexOf("WorkflowTaskSummary task={workflowTask}") < treeFull.indexOf("className={styles.treeTitleChevron}"));
  assert.ok(treeFull.indexOf("className={styles.treeTitleMain}") < treeFull.indexOf("WorkflowTaskSummary task={workflowTask}"));
  assert.match(treeFull, /生成完成/);
  assert.doesNotMatch(treeFull, /规划完成，已进入产品审查/);
  assert.match(styles, /\.treeTrailing \{[^}]*gap: 4px/);
  assert.match(styles, /\.overallStatus \{[^}]*justify-content: flex-end/);
  assert.match(styles, /\.overallStatus \{[^}]*text-overflow: ellipsis/);
});

test("后台任务合入生成规划标题，只保留一份进度", () => {
  const taskStrip = read("src/renderer/app/views/workflow-task/TaskStrip.tsx");
  assert.match(treeFull, /workflowTask: ProductWorkflowTask \| null/);
  assert.match(treeFull, /workflowTask \? <WorkflowTaskSummary task=\{workflowTask\}/);
  assert.match(treeFull, /!workflowTask \? <span className=\{styles\.progressValue\}/);
  assert.match(taskStrip, /export function WorkflowTaskSummary/);
  assert.match(taskStrip, /className=\{styles\.summaryTrack\} role="progressbar"[\s\S]*aria-valuenow=\{task\.progress\}/);
  assert.match(taskStrip, /role="status"[\s\S]*aria-atomic="true"/);
});

test("planning v2 mutation handlers delegate to the single Agent loop", () => {
  assert.match(planningV2Ipc, /ipcMain\.handle\("planning:start"[\s\S]*runPlanningIntent\(localProductId, "start"\)/,
    "planning:start must delegate to the durable Agent adapter");
  assert.doesNotMatch(planningV2Ipc, /const startPlanningUnderLock/,
    "the removed planning starter must not run alongside Agent");
  assert.match(planningV2Ipc, /planning:rerunMajorStage[\s\S]*sendPlanningIntent\(localProductId,/);
  assert.doesNotMatch(planningV2Ipc, /withPlanningLock|remoteProducts\.update|const runBody/);
});

test("itinerary adoption is expressed as an Agent intent", () => {
  assert.match(
    planningV2Ipc,
    /ipcMain\.handle\("planning:acceptItineraryAndRerunCompletion"[\s\S]*?sendPlanningIntent\(localProductId,/,
  );
  assert.doesNotMatch(planningV2Ipc, /acceptItineraryAndRerunCompletion\(\{/);
});

test("conversation itinerary adoption explains best-effort POI matching and manual fallback", () => {
  assert.match(treeFull, /尽力匹配当前行程的真实 POI/);
  assert.match(treeFull, /AI 推荐但未命中的景点会删除/);
  assert.match(treeFull, /用户点名但未命中的景点会保留/);
  assert.match(treeFull, /手动配置或删除/);
  assert.match(treeFull, /待手动/);
});

test("planning tree expands all major stages by default and exposes accessible controls", () => {
  assert.match(treeFull, /const isCollapsed = collapsed\[stage\.id\] \?\? false/);
  assert.match(treeFull, /aria-expanded=\{!isCollapsed\}/);
  assert.match(treeFull, /tabIndex=\{0\}/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /\.generationStatus/);
  assert.match(styles, /\.generationStatus > span/);
  assert.match(styles, /\.treeTitleMain > strong/);
  assert.match(confirmDialogStyles, /\.dialog::backdrop/);
  assert.match(confirmDialogStyles, /prefers-reduced-motion/);
  assert.match(confirmDialogStyles, /overflow-wrap: anywhere/);
});

test("login block, AI failure and node status have distinct operator-facing text", () => {
  // After split, status labels live in helpers.tsx (overallLabel / stageStatusLabel).
  assert.match(treeFull, /从失败节点继续|从被阻塞的节点继续/);
  assert.match(treeFull, /被阻塞/);
  assert.match(treeFull, /未通过/);
});
