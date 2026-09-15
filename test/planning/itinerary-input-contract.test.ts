import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { classifyItineraryInputMode, itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

function draft(userIdea: string, intent?: ProductDetail["planning"]): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { userIdea, subtitle: "成都两日", province: "四川", operationNotes: "按约定行程安排" });
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", spots: [{ name: "宽窄巷子" }], description: "游览", hotel: "无", meals: "自理" },
    { day: 2, title: "武侯祠", spots: [{ name: "武侯祠" }], description: "游览", hotel: "无", meals: "自理" },
  ];
  if (intent) product.planning = intent;
  return product;
}

test("无用户行程时允许完整生成", () => {
  const product = draft("想轻松一点，适合带孩子");
  const locked = extractLockedConstraints(product);
  assert.equal(classifyItineraryInputMode(locked, 2, product.planning?.userIntent), "open");
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "锦里" }] },
    { day: 2, spots: [{ name: "大熊猫基地" }] },
  ]), undefined);
});

test("部分用户约束必须保留指定 POI 和日序，只补空缺", () => {
  const product = draft("这次必须去宽窄巷子");
  const locked = extractLockedConstraints(product);
  assert.equal(classifyItineraryInputMode(locked, 2), "partial");
  assert.ok(locked.pois.includes("宽窄巷子"));
  assert.match(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "锦里" }] },
    { day: 2, spots: [{ name: "武侯祠" }] },
  ]) ?? "", /宽窄巷子/);
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "宽窄巷子" }, { name: "锦里" }] },
    { day: 2, spots: [{ name: "武侯祠" }] },
  ]), undefined);
});

test("完整每日行程禁止整体重排或替换，只允许规范化", () => {
  const product = draft("D1 去宽窄巷子，D2 去武侯祠，包车");
  const locked = extractLockedConstraints(product);
  assert.equal(classifyItineraryInputMode(locked, 2), "complete");
  assert.equal(locked.transport, "charter");
  assert.match(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "武侯祠" }] },
    { day: 2, spots: [{ name: "宽窄巷子" }] },
  ]) ?? "", /完整|重排|替换/);
  assert.match(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "宽窄巷子" }, { name: "锦里" }] },
    { day: 2, spots: [{ name: "武侯祠" }] },
  ]) ?? "", /完整|新增|替换/);
  assert.equal(itineraryInputContractError(product, [
    { day: 1, title: "宽窄巷子", spots: [{ name: "宽窄巷子", poiName: null, poiId: null }] },
    { day: 2, title: "武侯祠", spots: [{ name: "武侯祠", poiName: null, poiId: null }] },
  ]), undefined);
});

test("二选一必须完整保留，并以同一时段的 or 关系进入 VBK 录入链路", () => {
  const product = draft("日喀则2日游\nD1、火车站接-宽窄巷子-住日喀则\nD2、日喀则非物质遗产中心或者日喀则博物馆二选一【配讲解】--扎什伦布寺--送火车");
  const onlyFirst = [
    { day: 1, spots: [{ name: "宽窄巷子", relation: "and", timeOfDay: "morning" }] },
    { day: 2, spots: [{ name: "日喀则非物质遗产中心", relation: "or", timeOfDay: "morning" }] },
  ];
  assert.match(itineraryInputContractError(product, onlyFirst) ?? "", /二选一景点必须全部保留.*日喀则博物馆/);
  const wrongRelation = [
    { day: 1, spots: [{ name: "宽窄巷子", relation: "and", timeOfDay: "morning" }] },
    { day: 2, spots: [
      { name: "日喀则非物质遗产中心", relation: "and", timeOfDay: "morning" },
      { name: "日喀则博物馆", relation: "and", timeOfDay: "morning" },
    ] },
  ];
  assert.match(itineraryInputContractError(product, wrongRelation) ?? "", /relation: "or"/);
  const valid = [
    { day: 1, spots: [{ name: "宽窄巷子", relation: "and", timeOfDay: "morning" }] },
    { day: 2, spots: [
      { name: "日喀则非物质遗产中心", relation: "or", timeOfDay: "morning" },
      { name: "日喀则博物馆", relation: "or", timeOfDay: "morning" },
      { name: "扎什伦布寺", relation: "and", timeOfDay: "afternoon" },
    ] },
  ];
  assert.equal(itineraryInputContractError(product, valid), undefined);
});

test("行程后的 AI 自我修复说明不能被误识别为锁定景点", () => {
  const product = draft("日喀则2日游，4钻酒店。D1：火车站接-帕拉庄园【配讲解】-江孜宗山古堡【配讲解】-白居寺-住日喀则。D2：日喀则非物质遗产中心或者日喀则博物馆二选一【配讲解】--扎什伦布寺--送火车。资料准备好之前无需询问用户，如需处理请尽可能由 AI 自我修复。");
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["帕拉庄园", "江孜宗山古堡", "白居寺"] },
    { day: 2, spots: ["日喀则非物质遗产中心", "日喀则博物馆", "扎什伦布寺"] },
  ]);
  assert.ok(!locked.pois.some((poi) => poi.includes("自我修复")));
});

test("创建后的自动执行提示和端到端测试说明不能进入锁定景点", () => {
  const product = draft("日喀则2日游\n4钻酒店\nD1、火车站接-帕拉庄园【配讲解】-江孜宗山古堡【配讲解】-白居寺-住日喀则\nD2、日喀则非物质遗产中心或者日喀则博物馆二选一【配讲解】--扎实伦布寺--送火车\n\n端到端的测试行程录入，期望在资料准备好之前不需要询问用户，如果需要的话尽可能调整成ai自我修复。");
  product.messages = [
    ...product.messages,
    {
      id: "auto-start",
      role: "user",
      content: "请读取刚创建的产品和用户要求，完成本地规划与资源核验；任何 VBK 写入都必须先请求明确审批。",
      createdAt: "2026-09-10T00:00:00.000Z",
    },
  ];

  const locked = extractLockedConstraints(product, product.messages);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["帕拉庄园", "江孜宗山古堡", "白居寺"] },
    { day: 2, spots: ["日喀则非物质遗产中心", "日喀则博物馆", "扎实伦布寺"] },
  ]);
  assert.ok(!locked.pois.some((poi) => /端到端|资料准备|询问用户|明确审批/.test(poi)));
});

test("端到端验证授权说明不能进入锁定景点", () => {
  const product = draft("日喀则2日游\n4钻酒店\nD1、火车站接-帕拉庄园【配讲解】-江孜宗山古堡【配讲解】-白居寺-住日喀则\nD2、日喀则非物质遗产中心或者日喀则博物馆二选一【配讲解】--扎实伦布寺--送火车\n\n端到端的再创建产品验证。本次已授权在本地方案准备完成后录入 VBK 草稿；如果中途有问题，先修复共享问题，再重新创建新产品复验。");
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["帕拉庄园", "江孜宗山古堡", "白居寺"] },
    { day: 2, spots: ["日喀则非物质遗产中心", "日喀则博物馆", "扎实伦布寺"] },
  ]);
  assert.ok(!locked.pois.some((poi) => /端到端|授权|修复|复验/.test(poi)));
});

test("product.messages 中的最新纠正进入写入契约，只覆盖被纠正日期", () => {
  const product = draft("D1 去宽窄巷子，D2 去武侯祠，包车");
  product.messages = [
    ...product.messages,
    { id: "fix-1", role: "user", content: "第二天改成锦里", createdAt: "2026-09-09T00:00:00.000Z" },
    { id: "fix-2", role: "user", content: "第二天再改为大熊猫基地", createdAt: "2026-09-09T00:00:01.000Z" },
  ];
  const locked = extractLockedConstraints(product, product.messages);
  assert.equal(classifyItineraryInputMode(locked, 2), "complete");
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["大熊猫基地"] },
  ]);
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "宽窄巷子" }] },
    { day: 2, spots: [{ name: "大熊猫基地" }] },
  ]), undefined);
  assert.match(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "锦里" }] },
    { day: 2, spots: [{ name: "大熊猫基地" }] },
  ]) ?? "", /完整|重排|替换|缺失|宽窄巷子/);
});

test("明确取消旧景点后写入契约不再要求保留该景点", () => {
  const product = draft("D1 去宽窄巷子，D2 去武侯祠，包车");
  product.messages = [
    ...product.messages,
    { id: "cancel", role: "user", content: "不去武侯祠", createdAt: "2026-09-09T00:00:00.000Z" },
  ];
  const locked = extractLockedConstraints(product, product.messages);
  assert.ok(!locked.pois.includes("武侯祠"));
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "宽窄巷子" }] },
    { day: 2, spots: [{ name: "锦里" }] },
  ]), undefined);
  assert.doesNotThrow(() => agentPatchOperations(product, {
    itinerary: [{ day: 2, spots: [{ name: "锦里" }] }],
  }));
});

test("结构化 userIntent 优先于文本，写入前 patch 也会拒绝替换锁定景点", () => {
  const product = draft("随便写点博物馆和轻松行程", {
    version: 2,
    runId: "r",
    status: "running",
    currentNode: "itineraryDraft",
    nodes: [],
    poiCandidates: [],
    createdAt: "t",
    updatedAt: "t",
    userIntent: {
      rawIdea: "第一天宽窄巷子，第二天武侯祠",
      preferences: [],
      activities: [
        { id: "user-1", day: 1, title: "宽窄巷子", kind: "poi" },
        { id: "user-2", day: 2, title: "武侯祠", kind: "poi" },
      ],
    },
  });
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["武侯祠"] },
  ]);
  assert.ok(!locked.pois.includes("博物馆"));
  assert.throws(
    () => agentPatchOperations(product, { itinerary: [{ day: 1, spots: [{ name: "锦里" }] }] }),
    /宽窄巷子|完整|重排|替换/,
  );
});
