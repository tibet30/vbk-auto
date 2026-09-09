import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { agentPlannerContext, agentProductContext, agentTaskContext } from "../../src/main/agent/integration-context.js";
import { filterPlanningRequirementMessages, extractLockedConstraints, isPlanningControlMessage } from "../../src/main/agent/prompt-helpers.js";
import { PREPARATION_PROMPT_VERSION } from "../../src/shared/contracts-preparation.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

function draft(): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    subtitle: "成都两日私家团",
    province: "四川",
    operationNotes: "按约定行程安排",
    userIdea: "D1 去宽窄巷子，D2 去武侯祠，包车，当地4钻",
  });
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", description: "游览", hotel: "无", meals: "自理", spots: [{ name: "宽窄巷子", poiName: "宽窄巷子", poiId: 101 }] },
    { day: 2, title: "武侯祠", description: "游览", hotel: "无", meals: "自理", spots: [{ name: "武侯祠", poiName: "武侯祠", poiId: 102 }] },
  ];
  return product;
}

test("状态询问和继续执行不会污染行程需求", () => {
  const messages = [
    { role: "user" as const, content: "第二天不要安排购物" },
    { role: "user" as const, content: "现在进度怎么样" },
    { role: "user" as const, content: "继续执行" },
    { role: "user" as const, content: "确认录入" },
    { role: "user" as const, content: "把待处理事项处理掉" },
  ];
  assert.equal(isPlanningControlMessage("现在进度怎么样"), true);
  assert.equal(isPlanningControlMessage("继续执行"), true);
  assert.equal(isPlanningControlMessage("确认录入"), true);
  assert.equal(isPlanningControlMessage("第二天不要安排购物"), false);

  const filtered = filterPlanningRequirementMessages(messages);
  assert.deepEqual(filtered.map((item) => item.content), ["第二天不要安排购物"]);

  const product = draft();
  const context = agentPlannerContext(product, "测试", "model", messages);
  const userIdea = String((context.currentProduct.basicInfo as { userIdea?: string }).userIdea);
  assert.match(userIdea, /不要安排购物/);
  assert.doesNotMatch(userIdea, /现在进度怎么样/);
  assert.doesNotMatch(userIdea, /继续执行/);
  assert.doesNotMatch(userIdea, /确认录入/);
  assert.equal(context.history.length, 1);
  assert.equal(context.history[0]?.content, "第二天不要安排购物");
});

test("明确用户 POI 和行程约束被结构化为 lockedConstraints", () => {
  const product = draft();
  const locked = extractLockedConstraints(product, [
    { role: "user", content: "第一天必须去宽窄巷子，第二天去武侯祠，包车" },
    { role: "user", content: "继续执行" },
  ]);
  assert.equal(locked.destinationCity, "成都");
  assert.equal(locked.meetingCity, "成都");
  assert.equal(locked.days, 2);
  assert.equal(locked.transport, "charter");
  assert.ok(locked.pois.includes("宽窄巷子"));
  assert.ok(locked.pois.includes("武侯祠"));
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
  assert.match(String(locked.hotelTier), /4钻/);

  const planner = agentPlannerContext(product, "测试", "model", [
    { role: "user", content: "第一天必须去宽窄巷子，第二天去武侯祠" },
  ]);
  assert.ok(planner.lockedConstraints);
  assert.ok(planner.lockedConstraints.pois.includes("宽窄巷子"));
});

test("Agent 上下文复用同一 evaluator，并带 promptVersion 与权威 preparation", () => {
  const product = draft();
  const evaluation = evaluatePreparationCompletion(product);
  const visible = agentProductContext(product);
  assert.equal(visible.promptVersion, PREPARATION_PROMPT_VERSION);
  assert.equal(visible.preparation.ready, evaluation.ready);
  assert.equal(visible.preparation.currentStage, evaluation.currentStage);
  assert.deepEqual(visible.preparation.missing, evaluation.missing);
  assert.ok(!visible.preparation.allowedActions.includes("request_approval"));

  const context = agentTaskContext({ getProduct: () => product, getAgentSnapshot: () => undefined } as any, product.id);
  const parsed = JSON.parse(context);
  assert.equal(parsed.promptVersion, PREPARATION_PROMPT_VERSION);
  assert.equal(parsed.preparation.ready, evaluation.ready);
  assert.equal(parsed.currentStage, evaluation.currentStage);
  assert.equal(parsed.currentNode, evaluation.currentNode);
  assert.ok(parsed.lockedConstraints.pois.includes("宽窄巷子"));
  assert.ok(parsed.prohibitedActions.includes("request_approval"));
  assert.ok(Array.isArray(parsed.completionCriteria) && parsed.completionCriteria.length > 0);
  assert.ok(Array.isArray(parsed.rules));
  assert.ok(parsed.rules.some((rule: string) => rule.includes("request_approval 只能在 preparation.ready=true 时使用")));
  assert.ok(parsed.rules.some((rule: string) => rule.includes("留在当前阶段补齐")));
  assert.equal(typeof parsed.currentStage, "string");
  assert.ok(Array.isArray(parsed.missing));
  assert.ok(parsed.product && typeof parsed.product === "object");
  assert.equal(parsed.itineraryInputMode, evaluation.itineraryInputMode);
});

test("普通描述不会被解析成 lockedConstraints", () => {
  const product = draft();
  (product.product.basicInfo as { userIdea?: string }).userIdea = "成都两日慢游，想轻松一点，适合带孩子去博物馆看看";
  product.messages = [];
  const locked = extractLockedConstraints(product, [{ role: "user", content: "希望节奏不要太赶" }]);
  assert.ok(!locked.pois.includes("博物馆"));
  assert.deepEqual(locked.itineraryOrder, []);
  assert.equal(locked.transport, undefined);
});

test("结构化 userIntent 优先于含糊文本", () => {
  const product = draft();
  (product.product.basicInfo as { userIdea?: string }).userIdea = "随便安排博物馆和轻松行程";
  product.planning = {
    version: 2, runId: "r", status: "running", currentNode: "itineraryDraft",
    nodes: [], poiCandidates: [], createdAt: "t", updatedAt: "t",
    userIntent: {
      rawIdea: "第一天宽窄巷子",
      preferences: [],
      activities: [{ id: "user-1", day: 1, title: "宽窄巷子", kind: "poi" }],
    },
  };
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.pois, ["宽窄巷子"]);
  assert.deepEqual(locked.itineraryOrder, [{ day: 1, spots: ["宽窄巷子"] }]);
});

test("没有后续纠正时持续锁定首次结构化行程", () => {
  const product = draft();
  product.planning = {
    version: 2, runId: "r", status: "running", currentNode: "itineraryDraft",
    nodes: [], poiCandidates: [], createdAt: "t", updatedAt: "t",
    userIntent: {
      rawIdea: "第一天宽窄巷子，第二天武侯祠",
      preferences: [],
      activities: [
        { id: "user-1", day: 1, title: "宽窄巷子", kind: "poi" },
        { id: "user-2", day: 2, title: "武侯祠", kind: "poi" },
      ],
    },
  };
  const locked = extractLockedConstraints(product, [{ role: "user", content: "希望整体节奏轻松一点" }]);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
});

test("后续明确纠正按消息顺序覆盖对应日期，未纠正日期继续保留", () => {
  const product = draft();
  product.planning = {
    version: 2, runId: "r", status: "running", currentNode: "itineraryDraft",
    nodes: [], poiCandidates: [], createdAt: "t", updatedAt: "t",
    userIntent: {
      rawIdea: "第一天宽窄巷子，第二天武侯祠",
      preferences: [],
      activities: [
        { id: "user-1", day: 1, title: "宽窄巷子", kind: "poi" },
        { id: "user-2", day: 2, title: "武侯祠", kind: "poi" },
      ],
    },
  };
  const locked = extractLockedConstraints(product, [
    { role: "user", content: "第二天改成锦里" },
    { role: "user", content: "第二天再改为大熊猫基地" },
  ]);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["大熊猫基地"] },
  ]);
  assert.ok(!locked.pois.includes("武侯祠"));
  assert.ok(!locked.pois.includes("锦里"));
  assert.ok(locked.pois.includes("大熊猫基地"));
});

test("后续取消旧景点并改去新景点时以最新输入为准", () => {
  const product = draft();
  const locked = extractLockedConstraints(product, [
    { role: "user", content: "不去武侯祠，改去大熊猫基地" },
    { role: "user", content: "交通改为拼车" },
  ]);
  assert.ok(!locked.pois.includes("武侯祠"));
  assert.ok(locked.pois.includes("大熊猫基地"));
  assert.equal(locked.transport, "shared");
});
