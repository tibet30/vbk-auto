import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { agentPlannerContext } from "../../src/main/agent/integration-context.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import {
  classifyItineraryInputMode,
  itineraryInputContractError,
  planningWriteContractError,
} from "../../src/main/planning/itinerary-input-contract.js";
import { composePlanningUserMessage } from "../../src/main/planning/adapters/planning-prompt.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
import type { LockedConstraints } from "../../src/shared/contracts-preparation.js";

const FIRST_IDEA = "D1 去宽窄巷子，D2 去武侯祠，包车，当地4钻";

function draft(userIdea = FIRST_IDEA, later: string[] = []): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    subtitle: "成都两日",
    province: "四川",
    operationNotes: "按约定行程安排",
    userIdea,
  });
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", spots: [{ name: "宽窄巷子" }], description: "游览", hotel: "无", meals: "自理" },
    { day: 2, title: "武侯祠", spots: [{ name: "武侯祠" }], description: "游览", hotel: "无", meals: "自理" },
  ];
  product.messages = [
    ...product.messages,
    ...later.map((content, index) => ({
      id: `later-${index}`,
      role: "user" as const,
      content,
      createdAt: new Date(Date.parse("2026-09-09T00:00:00.000Z") + index * 1000).toISOString(),
    })),
  ];
  return product;
}

function lockedOf(product: ProductDetail): LockedConstraints {
  return extractLockedConstraints(product, product.messages);
}

function itinerary(day1: string, day2: string) {
  return [
    { day: 1, spots: [{ name: day1 }] },
    { day: 2, spots: [{ name: day2 }] },
  ];
}

test("无纠正时首次明确行程、交通和住宿必须原样锁定", () => {
  const product = draft();
  const locked = lockedOf(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
  assert.deepEqual(locked.pois, ["宽窄巷子", "武侯祠"]);
  assert.equal(locked.transport, "charter");
  assert.equal(locked.hotelTier, "当地4钻酒店/-4");
  assert.equal(locked.days, 2);
  assert.equal(classifyItineraryInputMode(locked, 2), "complete");
  assert.match(itineraryInputContractError(product, itinerary("武侯祠", "宽窄巷子")) ?? "", /完整|重排|替换/);
});

test("后续没有明确纠正时，软偏好不能改写首次锁定", () => {
  const product = draft(FIRST_IDEA, ["希望整体节奏轻松一点", "继续执行", "现在进度怎么样"]);
  const locked = lockedOf(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
  assert.equal(locked.transport, "charter");
  assert.equal(locked.hotelTier, "当地4钻酒店/-4");
  assert.equal(evaluatePreparationCompletion(product).itineraryInputMode, "complete");
});

test("多轮纠正同一天以最后一条为准，未纠正日期继续保留", () => {
  const product = draft(FIRST_IDEA, ["第二天改成锦里", "第二天再改为大熊猫基地"]);
  const locked = lockedOf(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["大熊猫基地"] },
  ]);
  assert.ok(!locked.pois.includes("武侯祠"));
  assert.ok(!locked.pois.includes("锦里"));
  assert.equal(locked.transport, "charter");
  assert.equal(locked.hotelTier, "当地4钻酒店/-4");
  assert.equal(itineraryInputContractError(product, itinerary("宽窄巷子", "大熊猫基地")), undefined);
  assert.match(itineraryInputContractError(product, itinerary("宽窄巷子", "锦里")) ?? "", /完整|重排|替换|缺失/);
});

test("只纠正交通时，行程日序和住宿档次继续保留首次输入", () => {
  const product = draft(FIRST_IDEA, ["交通改为拼车"]);
  const locked = lockedOf(product);
  assert.equal(locked.transport, "shared");
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
  assert.equal(locked.hotelTier, "当地4钻酒店/-4");
  assert.match(planningWriteContractError(product, "operations", { transport: "charter" }) ?? "", /交通方式已锁定/);
  assert.equal(planningWriteContractError(product, "operations", { transport: "shared" }), undefined);
});

test("只纠正住宿时，行程日序和交通继续保留首次输入", () => {
  const product = draft(FIRST_IDEA, ["改住当地3钻", "改住当地5钻"]);
  const locked = lockedOf(product);
  assert.equal(locked.hotelTier, "当地5钻酒店/-38");
  assert.equal(locked.transport, "charter");
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
});

test("明确取消旧景点后不再锁定该景点，未取消部分继续保留", () => {
  const product = draft(FIRST_IDEA, ["不去武侯祠"]);
  const locked = lockedOf(product);
  assert.deepEqual(locked.itineraryOrder, [{ day: 1, spots: ["宽窄巷子"] }]);
  assert.deepEqual(locked.pois, ["宽窄巷子"]);
  assert.ok(!locked.pois.includes("武侯祠"));
  assert.equal(classifyItineraryInputMode(locked, 2, product.planning?.userIntent), "partial");
  assert.equal(itineraryInputContractError(product, itinerary("宽窄巷子", "锦里")), undefined);
  assert.match(itineraryInputContractError(product, itinerary("锦里", "大熊猫基地")) ?? "", /宽窄巷子/);
});

test("evaluator 从 product.messages 读取最新明确纠正", () => {
  const product = draft(FIRST_IDEA, ["第二天改成锦里"]);
  const evaluation = evaluatePreparationCompletion(product);
  assert.deepEqual(evaluation.lockedConstraints.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["锦里"] },
  ]);
  assert.equal(evaluation.itineraryInputMode, "complete");
  assert.equal(evaluation.lockedConstraints.transport, "charter");
});

test("planner 上下文和 itinerary prompt 使用最新锁定约束", () => {
  const product = draft(FIRST_IDEA, ["第二天改成锦里", "交通改为拼车"]);
  const messages = product.messages
    .filter((message) => message.role === "user")
    .map((message) => ({ role: "user" as const, content: message.content }));
  const planner = agentPlannerContext(product, "test", "model", messages);
  assert.deepEqual(planner.lockedConstraints?.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["锦里"] },
  ]);
  assert.equal(planner.lockedConstraints?.transport, "shared");
  const prompt = composePlanningUserMessage({ stage: "itinerary", context: planner });
  assert.match(prompt, /行程输入模式：complete/);
  assert.ok(prompt.includes(JSON.stringify(planner.lockedConstraints)));
  assert.match(prompt, /禁止整体重排或替换，只允许规范化和 POI 核验/);
});
