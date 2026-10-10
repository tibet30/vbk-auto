import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { classifyItineraryInputMode, itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

test("送机或高铁的服务说明不生成景点二选一，真实景点选项仍锁定", () => {
  const product = draft("D1：宽窄巷子或锦里；D2：武侯祠；第2天送机或高铁不安排住宿。");
  const valid = [
    { day: 1, spots: [{ name: "宽窄巷子", relation: "or", timeOfDay: "morning" }, { name: "锦里", relation: "or", timeOfDay: "morning" }] },
    { day: 2, spots: [{ name: "武侯祠" }] },
  ];
  assert.equal(itineraryInputContractError(product, valid), undefined);
  assert.match(itineraryInputContractError(product, [{ ...valid[0], spots: valid[0]!.spots.slice(0, 1) }, valid[1]]) ?? "", /必须全部保留/);
});

test("完整路线后的交通排除和草稿边界不被识别为景点二选一", () => {
  const product = draft("第一天忠山公园、金龙寺，第二天尧坝古镇、玉蟾山，保留此顺序。当地5钻酒店、不含餐；不含飞机或火车交通子产品。仅保存草稿，不提交审核或发布。");
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "忠山公园" }, { name: "金龙寺" }] },
    { day: 2, spots: [{ name: "尧坝古镇" }, { name: "玉蟾山" }] },
  ]), undefined);
});

test("每日路线后的第1晚酒店候选不能被当成第2天的景点二选一", () => {
  const product = draft("第1天：忠山公园→金龙寺；第2天：尧坝古镇→泸县玉蟾山景区。景点顺序保持不变。5钻酒店，第1晚四川巨洋国际大饭店或泸州建国饭店，最后一天不住宿。");
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "忠山公园" }, { name: "金龙寺" }] },
    { day: 2, spots: [{ name: "尧坝古镇" }, { name: "泸县玉蟾山景区" }] },
  ]), undefined);
});

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

test("部分行程的送机约束允许保存在交通活动，不能强迫生成送机POI", () => {
  const product = draft("必须去宽窄巷子。D2：送机");
  const itinerary = [
    { day: 1, spots: [{ name: "宽窄巷子" }] },
    { day: 2, spots: [], activities: [{ type: "transport", title: "送机", detail: "按航班时间送往机场" }] },
  ];
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.match(itineraryInputContractError(product, [{ day: 1, spots: [] }, itinerary[1]]) ?? "", /宽窄巷子/);
});

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

test("大于号和箭头分隔的完整日程会逐点锁定", () => {
  const product = draft("D1: 宽窄巷子 > 锦里 → 武侯祠\nD2: 都江堰＞青城山");
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子", "锦里", "武侯祠"] },
    { day: 2, spots: ["都江堰", "青城山"] },
  ]);
  assert.match(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "宽窄巷子" }, { name: "武侯祠" }, { name: "锦里" }] },
    { day: 2, spots: [{ name: "都江堰" }, { name: "青城山" }] },
  ]) ?? "", /完整|重排|替换/);
});

test("完整行程中的送火车活动不是额外景点，不能用其他活动类型掩盖新增景点", () => {
  const product = draft("D1：宽窄巷子。D2：武侯祠 → 送火车。\n沿用最近产品要求：2天1晚私家团。");
  const route = [{ day: 1, spots: [{ name: "宽窄巷子" }] },
    { day: 2, spots: [{ name: "武侯祠" }, { name: "送火车", kind: "other" }] }];
  assert.equal(itineraryInputContractError(product, route), undefined);
  route[1]!.spots[1] = { name: "锦里", kind: "other" };
  assert.match(itineraryInputContractError(product, route) ?? "", /新增或替换景点.*锦里/);
});

test("日喀则三日实际回放保持景点和二选一，排除接送与末尾运营说明", () => {
  const product = draft("第一天：接火车 → 萨迦古城 → 萨迦寺 → 冲拉山欣赏珠峰东坡 → 住日喀则。\n第二天：帕拉庄园 → 满拉水库 → 卡若拉冰川 → 羊卓雍湖 → 住日喀则。\n第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺参观 → 送火车。\n沿用最近产品要求：3天2晚私家团，当地5钻酒店、不含餐。");
  product.product.basicInfo!.days = 3;
  const route = [
    { day: 1, spots: ["萨迦古城", "萨迦寺", "冲拉山欣赏珠峰东坡"].map(name => ({ name })) },
    { day: 2, spots: ["帕拉庄园", "满拉水库", "卡若拉冰川", "羊卓雍湖"].map(name => ({ name })) },
    { day: 3, spots: [
      { name: "日喀则博物馆", relation: "or", timeOfDay: "morning" },
      { name: "非遗中心参观", relation: "or", timeOfDay: "morning" },
      { name: "扎什伦布寺参观", relation: "and", timeOfDay: "afternoon" },
      { name: "送火车", kind: "other" },
    ] },
  ];
  assert.equal(itineraryInputContractError(product, route), undefined);
  assert.equal(extractLockedConstraints(product).pois.includes("接火车"), false);
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

test("每日行程后的运营设置语句不会污染最后一天的 POI", () => {
  const product = draft(
    "D1 潮州古城、广济桥、牌坊街。D2 潮汕历史文化博览中心、韩文公祠。D3 南澳岛、青澳湾。D4 潮州西湖、开元寺。D5 潮汕送团。接送团属于其他，自由活动用自由活动，这些不配置POI。城市固定潮州，酒店5钻，成人3680元儿童1980元，2人成团，每班库存30，出发2026-10-02至2027-09-30。保持跟团游，不影响其他私家团条款。只保存未提审草稿，不启用不提交审核。",
  );
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["潮州古城", "广济桥", "牌坊街"] },
    { day: 2, spots: ["潮汕历史文化博览中心", "韩文公祠"] },
    { day: 3, spots: ["南澳岛", "青澳湾"] },
    { day: 4, spots: ["潮州西湖", "开元寺"] },
    { day: 5, spots: ["潮汕送团"] },
  ]);
  assert.ok(!locked.pois.some((poi) => /接送团|自由活动|城市固定|酒店|3680|1980|成团|库存|2026|跟团游|私家团|保存|提审|启用|提交审核/.test(poi)));
});

test("出发去真实 POI 的路线不会被运营日期边界误截断", () => {
  const product = draft("D5 潮汕送团。出发去开元寺 > 广济桥");
  assert.deepEqual(extractLockedConstraints(product).itineraryOrder, [
    { day: 5, spots: ["潮汕送团。出发去开元寺", "广济桥"] },
  ]);
});

test("Markdown 日期标题不会污染每日锁定景点", () => {
  const product = draft("**10 月 4 号 D1：** 西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天峻石林星空）\n**10 月 5 号 D2：** 天峻 - 德令哈 - 大柴旦翡翠湖");
  Object.assign(product.product.basicInfo!, { meetingCity: "西宁", destinationCity: "西宁", destination: "西宁" });
  const locked = extractLockedConstraints(product);
  assert.deepEqual(locked.itineraryOrder, [
    { day: 1, spots: ["西宁", "青海湖", "茶卡盐湖", "天峻县"] },
    { day: 2, spots: ["天峻", "德令哈", "大柴旦翡翠湖"] },
  ]);
  assert.ok(!locked.pois.some((poi) => /\*\*|10 月|D[12]/.test(poi)));
  assert.equal(itineraryInputContractError(product, [
    { day: 1, description: "西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天峻石林星空）", spots: [{ name: "青海湖" }, { name: "茶卡盐湖" }] },
    { day: 2, description: "天峻 - 德令哈 - 大柴旦翡翠湖", spots: [{ name: "德令哈" }, { name: "大柴旦翡翠湖" }] },
  ]), undefined);
});

test("用户明确删除过境短地名后完整行程允许移除该 POI", () => {
  const product = draft("D1：德令哈 - 大柴旦翡翠湖\nD2：瓜州 - 敦煌");
  product.messages = [
    { id: "m1", role: "user", content: "删除德令哈这个过境城市 POI。", createdAt: "2026-09-18T00:00:00.000Z" },
    { id: "m2", role: "user", content: "删除瓜州、敦煌这两个散团城市 POI。", createdAt: "2026-09-18T00:00:01.000Z" },
  ] as never;
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "大柴旦翡翠湖" }] },
    { day: 2, spots: [] },
  ]), undefined);
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
