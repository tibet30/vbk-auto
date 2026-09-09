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
