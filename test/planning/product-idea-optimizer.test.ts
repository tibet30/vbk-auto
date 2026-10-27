import assert from "node:assert/strict";
import test from "node:test";
import { fingerprint, optimizeWithConstraintRetry, parseProductIdeaOptimizationResult } from "../../src/main/planning/product-idea-optimizer.js";
import { ideaConstraintDifference } from "../../src/main/planning/product-idea-constraint-guard.js";

test("产品想法优化结果保留变化、建议和待确认项", () => {
  const parsed = parseProductIdeaOptimizationResult("必须去晋祠，适合孩子", {
    optimizedIdea: "核心要求：必须去晋祠，适合孩子。建议：上午游览，下午休息。",
    preservedItems: ["晋祠", "亲子客群"],
    changes: [{ before: "适合孩子", after: "适合亲子家庭", reason: "表达更明确" }],
    recommendations: ["建议上午游览晋祠"],
    warnings: ["门票包含情况待确认"],
  });
  assert.equal(parsed.optimizedIdea.includes("晋祠"), true);
  assert.equal(parsed.changes[0]?.reason, "表达更明确");
  assert.deepEqual(parsed.warnings, ["门票包含情况待确认"]);
});

test("产品想法被改写但没有变化说明时拒绝结果", () => {
  assert.throws(() => parseProductIdeaOptimizationResult("去晋祠", {
    optimizedIdea: "改去其他地方", preservedItems: [], changes: [], recommendations: [], warnings: [],
  }), /没有说明变化/);
});

test("输入指纹覆盖目的地、天数、形态和原文", () => {
  const base = { destination: "太原", days: 2, productForm: "privateTour" as const, userIdea: "去晋祠" };
  assert.match(fingerprint(base), /^[a-f0-9]{64}$/);
  assert.notEqual(fingerprint(base), fingerprint({ ...base, days: 3 }));
});

const ORIGINAL = "DAY1：出发地-重庆万州-住万州\nDAY2：龙虹国家地质公园-张飞庙-住云阳";
const request = { userIdea: ORIGINAL, days: 2 };
const draft = (optimizedIdea: string) => ({ optimizedIdea, preservedItems: [], changes: [],
  recommendations: ["建议补充"], warnings: [] });
// 真实样本（万州 ae3316d7）：建议写进了逐日段落，规划把「如A或B」锁成二选一后卡死。
const LEAKED = "【DAY1】出发地 → 重庆万州，入住万州。\n（建议：抵达后游览，如万州大瀑布或西山公园。）\n【DAY2】龙虹国家地质公园 → 张飞庙，入住云阳。";
const CLEAN = "【DAY1】出发地 → 重庆万州，入住万州。\n【DAY2】龙虹国家地质公园 → 张飞庙，入住云阳。\n【补充建议】抵达当日可游览万州大瀑布或西山公园。";

test("优化稿把建议写进逐日段落时，带着差异重试一次并采用合规稿", async () => {
  const prompts: string[] = [];
  const result = await optimizeWithConstraintRetry(request, [], async (conversation) => {
    prompts.push(String(conversation.at(-1)?.content ?? ""));
    return parseProductIdeaOptimizationResult(ORIGINAL, draft(prompts.length === 1 ? LEAKED : CLEAN));
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /第1天新增二选一「如万州大瀑布或西山公园」/);
  assert.equal(result.optimizedIdea, CLEAN);
});

test("重试后仍改动逐日行程则拦截，不交给用户采用", async () => {
  let calls = 0;
  await assert.rejects(optimizeWithConstraintRetry(request, [], async () => {
    calls += 1;
    return parseProductIdeaOptimizationResult(ORIGINAL, draft(LEAKED));
  }), /改动了逐日行程.*已拦截/);
  assert.equal(calls, 2);
});

test("逐日段落与原文一致的优化稿不触发重试", async () => {
  let calls = 0;
  const result = await optimizeWithConstraintRetry(request, [], async () => {
    calls += 1;
    return parseProductIdeaOptimizationResult(ORIGINAL, draft(CLEAN));
  });
  assert.equal(calls, 1);
  assert.equal(result.optimizedIdea, CLEAN);
});

test("逐日差异识别：调换顺序、删除、新增景点都算改动，原文未写的天不核对", () => {
  const original = "DAY1：甲景区-乙景区\nDAY2：丙景区";
  assert.equal(ideaConstraintDifference(original, "第1天 甲景区 → 乙景区\n第2天 丙景区\n【补充建议】可加丁景区", 2), undefined);
  assert.match(ideaConstraintDifference(original, "第1天 乙景区 → 甲景区\n第2天 丙景区", 2) ?? "", /第1天景点/);
  assert.match(ideaConstraintDifference(original, "第1天 甲景区\n第2天 丙景区", 2) ?? "", /第1天景点/);
  assert.match(ideaConstraintDifference(original, "第1天 甲景区 → 乙景区\n第2天 丙景区 → 戊景区", 2) ?? "", /第2天景点/);
  assert.equal(ideaConstraintDifference("想去成都吃火锅", "建议：第1天成都市区，第2天都江堰", 2), undefined);
});
