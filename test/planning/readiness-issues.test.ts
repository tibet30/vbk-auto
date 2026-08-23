/**
 * 待处理事项去重 / 语义合并测试：
 *  - readiness 层把同一业务缺口只计一次；
 *  - renderer open issues helper 不再把 readiness 已覆盖的 research task 再追加一份；
 *  - 用车资源组基础 blocker 与车辆 research task 合并成单一可处理项。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ProductReadiness, ResearchTask } from "../../src/shared/contracts.js";
import { mergeReadinessIssues, openResearchTaskToIssue } from "../../src/shared/readiness-issues.js";
import { buildOpenIssueRows } from "../../src/renderer/app/views/workspace/review-summary-open-issues.helpers.js";

function task(id: string, label: string, type: ResearchTask["type"], detail?: string): ResearchTask {
  return {
    id,
    label,
    type,
    status: "queued",
    state: "researching",
    detail,
    evidence: [],
  };
}

test("缺 resourceGroupId + 用车 research task 只返回 1 个用车待处理项", () => {
  const issues = mergeReadinessIssues([
    openResearchTaskToIssue(task("vehicle-1", "核查用车资源组（按目的地 / 出行人数）", "vbk", "在 VBK 资源库确认有效资源组 ID")),
    { label: "用车资源组", detail: "私家团需要在 VBK 核查并填写现有用车资源组 ID。" },
  ]);
  const vehicleIssues = issues.filter((issue) => issue.label === "用车资源组");
  assert.equal(vehicleIssues.length, 1);
  assert.match(vehicleIssues[0].detail, /私家团需要在 VBK 核查并填写现有用车资源组 ID/);
});

test("非用车资源组待处理项不会被误合并成用车资源组", () => {
  const issues = mergeReadinessIssues([
    { label: "用车资源组", detail: "私家团需要在 VBK 核查并填写现有用车资源组 ID。" },
    openResearchTaskToIssue(task("hotel-group", "核查酒店资源组", "vbk", "确认酒店资源组 ID")),
    openResearchTaskToIssue(task("schema", "schema 错误：commercial.terms", "vbk", "条款结构非法，需要修正 JSON")),
  ]);
  assert.equal(issues.length, 3);
  assert.ok(issues.some((issue) => issue.label === "用车资源组"));
  assert.ok(issues.some((issue) => issue.label === "核查酒店资源组"));
  assert.ok(issues.some((issue) => issue.label === "schema 错误：commercial.terms"));
});

test("酒店 / 价格 / 库存 / 封面 research tasks 在 open issues 中不双份计数", () => {
  const tasks = [
    task("hotel", "核查 当地5钻酒店/-38 在 VBK 的酒店资源", "vbk", "确认酒店资源 ID"),
    task("price", "核查成人价 / 儿童价 / 起订人数在 VBK 是否可发布", "vbk", "确认价格口径"),
    task("inventory", "核查库存起止日期与每日配额在 VBK 是否生效", "vbk", "确认库存生效"),
    task("cover", "获取产品封面图（ctripLibrary 或人工上传）", "image", "补齐封面图"),
  ];
  const readiness: ProductReadiness = {
    ready: false,
    completion: 67,
    issues: tasks.map(openResearchTaskToIssue),
  };
  const rows = buildOpenIssueRows(readiness, tasks);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.label), readiness.issues.map((issue) => issue.label));
});

test("价格核查不会吞掉费用条款和运营成本口径核查", () => {
  const issues = mergeReadinessIssues([
    openResearchTaskToIssue(task("price", "核查成人价 / 儿童价 / 起订人数在 VBK 是否可发布", "vbk", "确认价格口径")),
    openResearchTaskToIssue(task("terms-cost", "核查费用包含 / 不包含 / 退改政策的运营成本口径", "cost", "确认费用包含、不包含与退改政策的运营成本口径")),
  ]);

  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.label === "核查成人价 / 儿童价 / 起订人数在 VBK 是否可发布"));
  assert.ok(issues.some((issue) => issue.label === "核查费用包含 / 不包含 / 退改政策的运营成本口径"));
});

test("多条边防证核查合并成单一待处理项", () => {
  const issues = mergeReadinessIssues([
    openResearchTaskToIssue(task("permit-1", "确认乃堆拉国门边防证办理口径", "cost", "是否需要代办边防证、代办费用与办理时长请人工确认并写入运营备注与预订须知。")),
    openResearchTaskToIssue(task("permit-2", "核实边防证办理口径", "vbk", "亚东乃堆拉属边境管控区，需确认边防证办理地点与可通行范围。")),
    openResearchTaskToIssue(task("permit-3", "复核边防证办理口径", "web", "复核定日/珠峰边境通行边防证办理口径，影响 bookingNotes。")),
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].label, "边防证办理口径");
  assert.match(issues[0].detail, /预订须知/);
});

test("open issues helper 合并 readiness 与 taskList 的重复用车项并修正 headMeta 计数来源", () => {
  const tasks = [
    task("vehicle", "核查西安私家团用车资源组（vehicle resourceGroupId）", "vbk", "调用 VBK 用车资源组接口查询"),
  ];
  const readiness: ProductReadiness = {
    ready: false,
    completion: 92,
    issues: [
      openResearchTaskToIssue(tasks[0]),
      { label: "用车资源组", detail: "私家团需要在 VBK 核查并填写现有用车资源组 ID。" },
    ],
  };
  const rows = buildOpenIssueRows(readiness, tasks);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "用车资源组");
  assert.match(rows[0].detail, /私家团需要在 VBK 核查并填写现有用车资源组 ID/);
  assert.match(rows[0].actionPrompt, /请核查并处理/);
});

test("open issues helper 不把空 readiness 外的 pending task 追加成待处理项", () => {
  const tasks = [
    task("hotel", "核查酒店资源组", "vbk", "确认酒店资源组 ID"),
  ];
  const readiness: ProductReadiness = {
    ready: true,
    completion: 100,
    issues: [],
  };

  const rows = buildOpenIssueRows(readiness, tasks);
  assert.equal(rows.length, 0);
});

test("open issues helper 只给匹配的 readiness issue 绑定 taskId 与核查提示", () => {
  const tasks = [
    task("hotel", "核查酒店资源组", "vbk", "确认酒店资源组 ID"),
    task("price", "核查成人价 / 儿童价 / 起订人数在 VBK 是否可发布", "vbk", "确认价格口径"),
  ];
  const readiness: ProductReadiness = {
    ready: false,
    completion: 88,
    issues: [
      openResearchTaskToIssue(tasks[0]),
    ],
  };

  const rows = buildOpenIssueRows(readiness, tasks);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "核查酒店资源组");
  assert.equal(rows[0].taskId, "hotel");
  assert.match(rows[0].actionPrompt, /请核查并处理：核查酒店资源组/);
});

test("readiness needs_user 阻塞必须作为 actionable 待处理项推送，不走 hidden 计数", () => {
  // 真实 bug：basic 阶段因 VBK 下拉中没有「安思科/1368298」而 needs_user。
  // 旧实现只加 hiddenBlockers，completion 跳到 92% 但 issues=[]，运营看不到
  // 「下一步要补什么」。新实现必须把 rec.userInstruction / rec.finalError
  // 作为一条以阶段名标识的待处理项吐出来；completion 由 issues.length 算出，
  // 不再有 hiddenBlockers 重复计数（否则 92% + 1 issue 会被算成 83%）。
  // 重构后 readiness() 实现已从 main.ts 迁移到 src/main/readiness.ts。
  const source = readFileSync(new URL("../../src/main/readiness.ts", import.meta.url), "utf8");

  // 必须用带阶段名的可操作 label 推送 needs_user 详情。
  assert.match(source, /issues\.push\(\{\s*label:\s*`自动录入失败：\$\{[^}]+\}`/,
    "readiness 必须用带阶段名的可操作 label 推送 needs_user 详情");
  // 详情必须从 rec.userInstruction 读（recovery-run.ts 暴露的字段）。
  assert.match(source, /blocked\.userInstruction|userInstruction/,
    "readiness 必须读 userInstruction 作为详情主体");
  // rec.userInstruction 缺失时必须回退到 finalError。
  assert.match(source, /finalError/,
    "userInstruction 缺失时必须回退到 finalError");
  // 不允许再有 hiddenBlockers 双计数：completion 由 issues.length 算出。
  assert.doesNotMatch(source, /hiddenBlockers/,
    "needs_user 不应再走 hidden 计数，避免 92%/0 pending 假就绪态 + 与 issues 重复计入 completion");
  assert.match(source, /const blockerCount = mergedIssues\.length\b/,
    "completion 必须单纯由 mergedIssues 算出，不再叠加 hiddenBlockers");
  assert.match(source, /Math\.min\((?:12|READINESS_MAX_BLOCKERS), blockerCount\)/);
  assert.match(source, /ready: blockerCount === 0/);
});

test("readiness 用户主动取消不产生新的待处理项", () => {
  // rec.finalError 以「用户中止」开头时是用户已知动作，不重复产生任务，
  // 避免与顶部「已停止」状态重复。
  // 重构后 readiness() 实现已从 main.ts 迁移到 src/main/readiness.ts。
  const source = readFileSync(new URL("../../src/main/readiness.ts", import.meta.url), "utf8");

  assert.match(source, /用户中止/,
    "readiness 必须以 finalError 前缀识别用户主动取消");
  assert.match(source, /startsWith\(\s*["']用户中止["']\s*\)/,
    "识别逻辑必须严格使用 startsWith 避免被其它错误文本误命中");
  // 取消分支不能调用 issues.push(自动录入失败 …)，避免与顶部「已停止」重复。
  // 用「cancelled 为 true 时跳过 push」语义锁死：if (!cancelled) 块内才有 push。
  const cancelledCheckIdx = source.search(/const cancelled\b/);
  const pushIdx = source.indexOf("issues.push({ label:", cancelledCheckIdx);
  assert.ok(cancelledCheckIdx > 0, "readiness 必须先识别 cancelled");
  assert.ok(pushIdx > cancelledCheckIdx, "issues.push 必须在 cancelled 检查之后");
  const betweenCancAndPush = source.slice(cancelledCheckIdx, pushIdx);
  assert.match(betweenCancAndPush, /if\s*\(\s*!cancelled\s*\)/,
    "issues.push 必须在 if (!cancelled) 块内；取消分支不应 push 待处理项");
});
