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

test("结构合法但丢失锁定景点的旧草稿仍按原始完整路线重建", () => {
  const product = draft();
  const stale = projectedItinerary(product);
  stale[0]!.spots = (stale[0]!.spots as any[]).filter((spot) => spot.name !== "萨迦古城");
  stale[0]!.title = "萨迦寺 · 冲拉山欣赏珠峰东坡";
  stale[0]!.description = "按旧草稿安排。";
  product.product.itinerary = stale as any;
  assert.match(itineraryInputContractError(product, stale) ?? "", /萨迦古城/u);
  assert.ok(projectCompleteItinerary(product));
});

test('dated cross-city routes preserve night experiences and overnight endpoints through projection', () => {
  const product = buildProductSnapshot({ destination: '西宁', days: 2, productForm: 'privateTour',
    userIdea: '**10 月 4 号 D1：** 西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天俊石林星空）\n**10 月 5 号 D2：** 天峻 - 德令哈 - 大柴旦翡翠湖' });
  product.product.itinerary = [];
  Object.assign(product.product.basicInfo!, { province: '青海', subtitle: '星空路线', operationNotes: '保留原始路线' });
  const itinerary = projectedItinerary(product);
  assert.match(String(itinerary[0]!.hotel), /天峻县/);
  assert.doesNotMatch(String(itinerary[0]!.hotel), /西宁/);
  assert.match(JSON.stringify(itinerary[0]!.activities), /天俊石林星空/);
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.equal(itinerary[1]!.hotel, '无');
});

test("投影保留类似名称景点，后续逐日住宿修正则回退", () => {
  const product = draft(RIKAZE_ROUTE.replace("萨迦古城", "接送码头公园-萨迦古城"));
  const itinerary = projectedItinerary(product);
  const dayOne = itinerary[0]!;
  assert.ok((dayOne.spots as any[]).some((spot) => spot.name === "接送码头公园" && spot.kind === "attraction"));
  product.messages = [{ role: "user", content: "第一天住宿改为拉萨。" }] as any;
  assert.equal(projectCompleteItinerary(product), undefined);
});

test("创建产品的 product_brief 消息是原始需求副本，不会误判为后续修订", () => {
  const product = draft();
  product.messages = [{ role: "user", content: JSON.stringify({
    type: "product_brief", destination: "日喀则", days: 3, nights: 2,
    userIdea: RIKAZE_ROUTE,
  }) }] as any;
  assert.ok(projectCompleteItinerary(product));
});

test("要求重放原始完整路线属于控制指令，不会阻断确定性恢复", () => {
  const product = draft();
  product.messages = [{ role: "user", content:
    "请从头重新规划当前产品，按原始完整逐日路线重新生成并继续本地资源核验；保持原住宿城市。" }] as any;
  assert.ok(projectCompleteItinerary(product));
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

test("阿里括号宿点路线确定性投影，不再交给模型重写或把末日补成住宿", () => {
  const idea = [
    "D1天：拉萨—羊卓雍措—普莫雍措—卡若拉冰川—日喀则（宿日喀则） - 看点：羊卓雍湖，库拉岗日冰川",
    "D2天：日喀则—扎什伦布寺—萨迦寺—十万个沙丘—珠峰（宿珠峰小镇） - 看点：洛子峰，珠峰绒布冰川遗迹",
    "D3天：巴松村—佩枯措—希夏邦马峰冰川群—萨嘎（宿萨嘎） - 看点：珠穆朗玛峰风景区，希夏邦马，拉普古村寨",
    "D4天：萨嘎—仲巴五彩沙漠—公珠措—冈仁波齐—玛旁雍措—拉昂措（宿塔尔钦）",
    "D5天：塔钦—札达—塔钦（宿塔尔钦） - 看点：扎达土林，古格王朝，托林寺",
    "D6天：塔钦—仲巴—萨嘎（宿萨嘎） - 看点：冈仁波齐，玛旁雍措，拉昂措，公珠措，五彩沙丘",
    "D7天：萨嘎—22道班—日喀则—拉萨 - 看点：索比拉亚山，达格架喷泉，桑桑大草原，浪措湖",
  ].join(" ");
  const product = buildProductSnapshot({ destination: "拉萨", days: 7, productForm: "privateTour", userIdea: idea });
  Object.assign(product.product.basicInfo!, { days: 7, nights: 6, meetingCity: "拉萨", destinationCity: "拉萨" });
  product.product.itinerary = [];

  const itinerary = projectedItinerary(product);
  assert.equal(itinerary.length, 7);
  assert.deepEqual(itinerary.slice(0, 6).map((day) => day.hotel), [
    "日喀则（待匹配）", "珠峰小镇（待匹配）", "萨嘎（待匹配）",
    "塔尔钦（待匹配）", "塔尔钦（待匹配）", "萨嘎（待匹配）",
  ]);
  assert.equal(itinerary[6]!.hotel, "无");
  assert.ok((itinerary[2]!.spots as any[]).some((spot) => spot.name === "巴松村"),
    "前夜只明确宿珠峰小镇，不能用地点别名把原路线巴松村降为住宿衔接");
  assert.ok((itinerary[0]!.spots as any[]).some((spot) => spot.name === "羊卓雍湖"));
  assert.ok((itinerary[0]!.spots as any[]).some((spot) => spot.name === "库拉岗日冰川"));
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.equal(itineraryStructureError({ ...product.product, itinerary }), undefined);
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
    assert.equal(reloaded.product.itinerary?.[0]?.hotelCity, "日喀则");
    assert.equal(reloaded.product.itinerary?.[1]?.hotelCity, "日喀则");
    assert.equal(reloaded.product.itinerary?.[2]?.hotel, "无当日住宿安排");
    const alternative = reloaded.product.itinerary?.[2]?.spots?.filter((spot) => /日喀则博物馆|非遗中心参观/.test(spot.name)) ?? [];
    assert.equal(alternative.length, 2);
    assert.ok(alternative.every((spot) => spot.relation === "or" && spot.timeOfDay === alternative[0]!.timeOfDay));
    assert.equal(reloaded.product.basicInfo?.meetingCity, "日喀则");
    assert.equal(reloaded.product.basicInfo?.destinationCity, "日喀则");
    assert.equal(reloaded.product.operations?.hotelMatchingMode, "rules");
    assert.deepEqual(reloaded.product.operations?.hotelRules, { autoMatch: true, grades: [3, 4, 5] });
    assert.equal(reloaded.product.operations?.hotelTier, undefined);
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
});
