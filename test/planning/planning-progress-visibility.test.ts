/** 规划阶段进度与实时状态更新后的 UI 契约。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PLANNING_STAGES } from "../../src/shared/contracts-planning.js";
import {
  buildPlanningStageProgress,
  planningStageLabel,
  PLANNING_STAGE_LABELS,
} from "../../src/renderer/app/helpers/constants.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const reviewSrc = read("src/renderer/app/views/workspace/review.tsx");
const treeSrc = read("src/renderer/app/views/workspace/planning-tree.tsx");
const lessSrc = read("src/renderer/app/views/workspace/planning-tree.module.less");
const derivedSrc = read("src/renderer/app/state/derived.ts");

test("实时 running 状态仍按共享阶段顺序显示已完成、进行中、待开始", () => {
  const progress = buildPlanningStageProgress(
    { currentStage: "itinerary", completedStages: ["skeleton", "basicInfo"] },
    PLANNING_STAGES,
  );
  assert.deepEqual(progress.map((item) => item.stage), [...PLANNING_STAGES]);
  assert.deepEqual(progress.filter((item) => item.state === "completed").map((item) => item.stage), ["skeleton", "basicInfo"]);
  assert.equal(progress.find((item) => item.state === "current")?.stage, "itinerary");
  for (const item of progress) {
    assert.equal(item.label, PLANNING_STAGE_LABELS[item.stage]);
    assert.notEqual(item.label, item.stage);
  }
});

test("Agent 对话承载输入、确认和失败恢复", () => {
  const agent=read("src/renderer/app/views/workspace/agent-conversation.tsx");
  assert.match(reviewSrc, /<AgentConversation/);
  assert.match(agent, /<AgentInput/);
  assert.match(agent, /确认方案并录入 VBK/);
  assert.match(agent, /agent\.resume\(product.id\)/);
});

test("规划树为横向三列，节点显式展示状态、尝试次数和 POI 数量", () => {
  assert.match(treeSrc, /产品骨架/);
  assert.match(treeSrc, /行程规划/);
  assert.match(treeSrc, /产品补全/);
  assert.match(treeSrc, /推荐 \$\{recommended\} \/ 命中 \$\{matched\} \/ 采用 \$\{selected\}/);
  assert.match(treeSrc, /\{node\.attempts\}\/3/);
  assert.match(lessSrc, /grid-template-columns:\s*minmax\(220px/);
  assert.match(lessSrc, /overflow-x:\s*auto/);
});

test("阶段标签总是中文，避免 event state 直接泄漏裸 stage id", () => {
  for (const stage of PLANNING_STAGES) {
    assert.match(planningStageLabel(stage), /[一-鿿]/);
  }
  assert.equal(planningStageLabel(undefined), "当前阶段");
});

test("方案对话保留独立滚动容器和新消息提示", () => {
  const agent=read("src/renderer/app/views/workspace/agent-conversation.tsx");
  assert.match(agent, /ref=\{viewport\}/);
  assert.match(agent, /if \(follow.current\) node.scrollTop = node.scrollHeight/);
  assert.match(agent, /有新消息/);
  assert.doesNotMatch(agent, /ref=\{browserRef\}/);
});
