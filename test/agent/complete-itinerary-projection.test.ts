import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { projectCompleteItinerary } from "../../src/main/planning/complete-itinerary-projection.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { itineraryStructureError } from "../../src/main/planning/itinerary-structure.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const RIKAZE_ROUTE = `日喀则火车站起止。
第一天接火车-萨迦古城-萨迦寺-冲拉山欣赏珠峰东坡-住日喀则。
第二天帕拉庄园-满拉水库-卡若拉冰川-羊卓雍湖-住日喀则。
第三天日喀则博物馆或者非遗中心参观-扎什伦布寺参观，送火车。`;

function draft(userIdea = RIKAZE_ROUTE): ProductDetail {
  const product = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    days: 3, nights: 2, meetingCity: "日喀则", destinationCity: "日喀则", province: "西藏", userIdea,
  });
  Object.assign(product.product.operations!, { hotelTier: "当地5钻酒店/-38", transport: "charter", pickupCity: "日喀则" });
  product.product.itinerary = [];
  return product;
}

function projectedItinerary(product: ProductDetail): Array<Record<string, unknown>> {
  const output = projectCompleteItinerary(product);
  assert.ok(output);
  const value = output.modules[0]?.value;
  assert.ok(Array.isArray(value));
  return value as Array<Record<string, unknown>>;
}

test("完整日喀则输入在模型前投影为原序逐日行程", () => {
  const product = draft();
  const itinerary = projectedItinerary(product);
  assert.equal(itinerary.length, 3);
  assert.deepEqual(itinerary[0]!.spots!.map((spot: any) => spot.name), ["萨迦古城", "萨迦寺", "冲拉山欣赏珠峰东坡"]);
  assert.match(String(itinerary[0]!.description), /火车站接站服务/);
  assert.doesNotMatch(String(itinerary[0]!.description), /接送服务/);
  assert.ok(!itinerary.flatMap((day) => day.spots as any[]).some((spot) => spot.name === "日喀则火车站"));
  assert.match(String(itinerary[0]!.hotel), /日喀则/);
  assert.match(String(itinerary[1]!.hotel), /日喀则/);
  assert.equal(itinerary[2]!.hotel, "无");
  assert.match(String(itinerary[2]!.description), /火车站送站服务/);

  const alternatives = (itinerary[2]!.spots as any[]).filter((spot) => /日喀则博物馆|非遗中心参观/.test(spot.name));
  assert.equal(alternatives.length, 2);
  assert.ok(alternatives.every((spot) => spot.relation === "or" && spot.timeOfDay === alternatives[0]!.timeOfDay));
  const indexes = alternatives.map((spot) => (itinerary[2]!.spots as any[]).indexOf(spot));
  assert.equal(indexes[1], indexes[0]! + 1);
  assert.equal(itinerary[2]!.title, "日喀则博物馆或非遗中心参观（二选一） · 扎什伦布寺参观");
  assert.match(String(itinerary[2]!.description), /^按用户原定顺序安排：日喀则博物馆或非遗中心参观（二选一）、扎什伦布寺参观。/u);
  assert.ok(itinerary.flatMap((day) => day.spots as any[]).every((spot) => spot.poiId === null && spot.poiName === null));
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.equal(itineraryStructureError({ ...product.product, itinerary }), undefined);
});

test("只对完整且当前结构无效的输入投影", () => {
  const valid = draft();
  valid.product.itinerary = projectedItinerary(valid) as any;
  assert.equal(projectCompleteItinerary(valid), undefined);
  assert.equal(projectCompleteItinerary(draft("第一天萨迦古城。")), undefined);
  assert.equal(projectCompleteItinerary(draft("日喀则轻松游。")), undefined);
});

test("投影保留类似名称景点，后续逐日住宿修正则回退", () => {
  const product = draft(RIKAZE_ROUTE.replace("萨迦古城", "接送码头公园-萨迦古城"));
  const itinerary = projectedItinerary(product);
  const dayOne = itinerary[0]!;
  assert.ok((dayOne.spots as any[]).some((spot) => spot.name === "接送码头公园" && spot.kind === "attraction"));
  product.messages = [{ role: "user", content: "第一天住宿改为拉萨。" }] as any;
  assert.equal(projectCompleteItinerary(product), undefined);
});

test("D1 的住宿不会误取 D10 段落", () => {
  const product = buildProductSnapshot({ destination: "日喀则", days: 10, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    days: 10, nights: 9, meetingCity: "日喀则", destinationCity: "日喀则", province: "西藏",
    userIdea: Array.from({ length: 10 }, (_, index) => `D${index + 1}景点${index + 1}-住${index === 0 ? "甲地" : "乙地"}。`).join("\n"),
  });
  product.product.itinerary = [];
  const itinerary = projectedItinerary(product);
  assert.match(String(itinerary[0]!.hotel), /甲地/);
  assert.doesNotMatch(String(itinerary[0]!.hotel), /乙地/);
});

test("原始完整输入的住宿写法保留地点而不截成宿字", () => {
  const itinerary = projectedItinerary(draft(RIKAZE_ROUTE.replaceAll("住日喀则", "住宿：日喀则")));
  assert.match(String(itinerary[0]!.hotel), /日喀则/);
  assert.doesNotMatch(String(itinerary[0]!.hotel), /宿日喀则/);
});

async function assertBusinessToolFallsBack(initial: ProductDetail): Promise<void> {
  const dataPath = mkdtempSync(path.join(tmpdir(), "vbk-complete-itinerary-fallback-"));
  const db = new VbkDatabase(dataPath);
  let generateCalls = 0;
  try {
    const laterMessages = initial.messages.filter((message) => !message.id || !message.createdAt);
    db.importProductSnapshot({ ...initial, messages: initial.messages.filter((message) => message.id && message.createdAt) });
    for (const message of laterMessages) db.addMessage(initial.id, message.role, message.content, message.taskStatus);
    const tools = createAgentBusinessTools({
      db, browser: undefined as any, automation: {} as any,
      productWorkflows: {
        runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
        runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
      } as any,
      productMutations: new ProductMutationService(db),
      generateStage: async () => { generateCalls += 1; throw new Error("fallback-model-called"); },
      disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
      disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }), emitProduct: () => undefined,
    });
    const tool = tools.find((item) => item.name === "generate_product_module");
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute({ stage: "itinerary" }, { localProductId: initial.id, accountKey: "a", productVersion: "v" }),
      /fallback-model-called/,
    );
    assert.equal(generateCalls, 1);
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
}

test("真实业务工具对 open、partial、已有有效和歧义输入回退模型", async () => {
  const valid = draft();
  valid.product.itinerary = projectedItinerary(valid) as any;
  const ambiguous = draft("日喀则轻松游。");
  ambiguous.planning = { userIntent: {
    rawIdea: "三天活动", preferences: [], activities: [1, 2, 3].map((day) => ({ id: `a-${day}`, day, title: "自由活动", kind: "activity" })),
  } } as any;
  const lodgingCorrection = draft();
  lodgingCorrection.messages = [{ role: "user", content: "第一天住宿改为拉萨。" }] as any;
  const cancelledAlternative = draft();
  cancelledAlternative.messages = [{ role: "user", content: "第三天改为日喀则博物馆-扎什伦布寺参观。" }] as any;
  const newAlternative = draft();
  newAlternative.messages = [{ role: "user", content: "第三天改为日喀则博物馆或者非遗中心参观-扎什伦布寺参观。" }] as any;
  const flightService = draft(RIKAZE_ROUTE.replace("第一天接火车", "第一天接机"));
  const poiCorrection = draft();
  poiCorrection.messages = [{ role: "user", content: "把萨迦寺改为白居寺。" }] as any;
  const noDayLodgingCorrection = draft();
  noDayLodgingCorrection.messages = [{ role: "user", content: "住宿改为拉萨。" }] as any;
  const firstNightCorrection = draft();
  firstNightCorrection.messages = [{ role: "user", content: "第一晚住甲城。" }] as any;
  for (const product of [draft("第一天萨迦古城。"), draft("日喀则轻松游。"), valid, ambiguous, lodgingCorrection, cancelledAlternative, newAlternative, flightService, poiCorrection, noDayLodgingCorrection, firstNightCorrection]) {
    await assertBusinessToolFallsBack(product);
  }
});

test("隔离 SQLite 中完整行程不调用模型，写入后重连仍可读", async () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "vbk-complete-itinerary-"));
  let db = new VbkDatabase(dataPath);
  let generateCalls = 0;
  try {
    const initial = draft();
    initial.product.operations!.trafficLine = {
      enabled: false,
      variants: [],
      availability: {
        availableVariants: [],
        unavailableVariants: {
          trainRoundTrip: "未找到唯一可确认的火车站候选",
          flightRoundTrip: "未找到唯一可确认的机场候选",
        },
      },
    };
    db.importProductSnapshot(initial);
    const tools = createAgentBusinessTools({
      db, browser: undefined as any, automation: {} as any,
      productWorkflows: {
        runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
        runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
      } as any,
      productMutations: new ProductMutationService(db),
      generateStage: async () => { generateCalls += 1; throw new Error("不应调用模型"); },
      disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
      disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }), emitProduct: () => undefined,
    });
    const tool = tools.find((item) => item.name === "generate_product_module");
    assert.ok(tool);
    await tool.execute({ stage: "itinerary" }, { localProductId: initial.id, accountKey: "a", productVersion: "v" });
    assert.equal(generateCalls, 0);
    const persisted = db.getProduct(initial.id)!;
    assert.equal(itineraryStructureError(persisted.product), undefined);
    assert.equal(itineraryInputContractError(persisted, persisted.product.itinerary), undefined);
    db.close();
    db = new VbkDatabase(dataPath);
    const reloaded = db.getProduct(initial.id)!;
    assert.equal(reloaded.product.itinerary?.length, 3);
    assert.deepEqual(reloaded.product.itinerary?.[0]?.spots?.map((spot) => spot.name), ["萨迦古城", "萨迦寺", "冲拉山欣赏珠峰东坡"]);
    assert.equal(reloaded.product.itinerary?.flatMap((day) => day.spots ?? []).length, 10);
    assert.match(reloaded.product.itinerary?.[0]?.hotel ?? "", /日喀则/);
    assert.match(reloaded.product.itinerary?.[1]?.hotel ?? "", /日喀则/);
    assert.equal(reloaded.product.itinerary?.[2]?.hotel, "无");
    const alternative = reloaded.product.itinerary?.[2]?.spots?.filter((spot) => /日喀则博物馆|非遗中心参观/.test(spot.name)) ?? [];
    assert.equal(alternative.length, 2);
    assert.ok(alternative.every((spot) => spot.relation === "or" && spot.timeOfDay === alternative[0]!.timeOfDay));
    assert.equal(reloaded.product.basicInfo?.meetingCity, "日喀则");
    assert.equal(reloaded.product.basicInfo?.destinationCity, "日喀则");
    assert.equal(reloaded.product.operations?.hotelTier, "当地5钻酒店/-38");
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
});
