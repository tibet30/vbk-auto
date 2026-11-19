import test from "node:test";
import assert from "node:assert/strict";
import { ReplayDataMissingError } from "../../src/main/infrastructure/replay-data-error.js";
import { dayTitleFacts, ensureDayTitleFits, fallbackDayTitle, generateItineraryDayTitles, type ItineraryDayTitleRequest } from "../../src/main/planning/itinerary-day-titles.js";
import { ITINERARY_DAY_TITLE_MAX_LENGTH, itineraryDayTitleBudget } from "../../src/shared/itinerary-day-title.js";
import { normaliseItineraryArrivalTitle } from "../../src/shared/itinerary-arrival-title.js";

const product = { basicInfo: { meetingCity: "万州", destinationCity: "万州", days: 3 } };
const itinerary = [
  { day: 1, title: "万州-入住城区", spots: [] },
  { day: 2, title: "龙虹国家地质公园-张飞庙", spots: [{ name: "龙虹国家地质公园" }, { name: "张飞庙" }] },
  { day: 3, title: "白帝城-三峡之巅", spots: [{ name: "白帝城" }, { name: "三峡之巅" }] },
];

test("首日标题预算扣除【出发地-城市】前缀，最终写入长度不超过上限", () => {
  const budget = itineraryDayTitleBudget(product, 1);
  assert.equal(budget, ITINERARY_DAY_TITLE_MAX_LENGTH - "【出发地-万州】".length);
  const long = { day: 1, title: "甲-".repeat(budget + 5), spots: [] };
  const fitted = ensureDayTitleFits(product, long);
  const saved = normaliseItineraryArrivalTitle({ ...product, itinerary: [fitted] }).itinerary as Array<{ title: string }>;
  assert.ok([...saved[0]!.title].length <= ITINERARY_DAY_TITLE_MAX_LENGTH);
});

test("AI 标题通过校验即采纳，并把每天的景点、起点、住段与预算传给 AI", async () => {
  let seen: ItineraryDayTitleRequest[] = [];
  const result = await generateItineraryDayTitles({
    product, itinerary, sourceText: () => "原文",
    generate: async (requests) => {
      seen = requests;
      return [
        { day: 1, title: "万州-入住城区" },
        { day: 2, title: "云阳龙虹国家地质公园-张飞庙古迹" },
        { day: 3, title: "奉节白帝城-三峡之巅观景" },
      ];
    },
  });
  assert.deepEqual(result.map((day) => day.title), ["万州-入住城区", "云阳龙虹国家地质公园-张飞庙古迹", "奉节白帝城-三峡之巅观景"]);
  assert.deepEqual(seen[1]!.requiredNames, ["龙虹国家地质公园"]);
  assert.deepEqual(seen[1]!.optionalNames, ["张飞庙"]);
  assert.equal(seen[0]!.maxLength, itineraryDayTitleBudget(product, 1));
  assert.equal(seen[0]!.startName, "万州");
  assert.equal(seen[0]!.stayName, "");
  assert.equal(seen[0]!.stayAllowed, false);
  assert.deepEqual(seen[0]!.includeNotes, []);
});

test("不合格标题带原因重试一次，仍不合格保留原标题", async () => {
  const calls: ItineraryDayTitleRequest[][] = [];
  const warnings: string[] = [];
  const result = await generateItineraryDayTitles({
    product, itinerary, sourceText: () => "",
    onWarning: (message) => warnings.push(message),
    generate: async (requests) => {
      calls.push(requests);
      return requests.map((request) => request.day === 2
        ? { day: 2, title: "张飞庙-白帝城" }
        : request.day === 3 ? { day: 3, title: "白帝城-三峡之巅\n（建议早去）" } : { day: 1, title: "万州" });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.map((request) => request.day), [2, 3]);
  assert.match(calls[1]![0]!.rejectedReason ?? "", /龙虹国家地质公园/u);
  assert.match(calls[1]![1]!.rejectedReason ?? "", /换行/u);
  assert.equal(result[0]!.title, "万州");
  assert.equal(result[1]!.title, itinerary[1]!.title);
  assert.equal(result[2]!.title, itinerary[2]!.title);
  assert.equal(warnings.length, 2);
});

test("AI 调用失败时不中断，保留确定性标题", async () => {
  const result = await generateItineraryDayTitles({
    product, itinerary, sourceText: () => "",
    generate: async () => { throw new Error("timeout"); },
  });
  assert.deepEqual(result.map((day) => day.title), itinerary.map((day) => day.title));
});

test("缺少模型回放时向上抛出，不能降级为兜底标题", async () => {
  const missing = new ReplayDataMissingError("missing title replay");
  await assert.rejects(generateItineraryDayTitles({
    product, itinerary, sourceText: () => "",
    generate: async () => { throw new Error("transport", { cause: missing }); },
  }), (error: unknown) => error instanceof Error && error.cause === missing);
});

test("兜底标题按新骨架连接，不在字符中间截断，也不丢整段景点名", () => {
  const names = ["萨嘎", "仲巴五彩沙漠", "公珠措", "普兰境内主峰", "玛旁雍措", "拉昂措", "马泉河湿地", "纳木那尼峰"];
  const title = fallbackDayTitle({ day: 4, title: names.join(" · "), names, budget: 30 });
  assert.ok([...title].length <= 30, title);
  for (const part of title.split("-")) assert.ok(names.includes(part), part);
  assert.equal(fallbackDayTitle({ day: 5, title: "甲".repeat(40), names: [], budget: 30 }), "第5天行程安排");
});

test("途经城市须保持独立路线节点，超长兜底也保留节点", async () => {
  const routeProduct = { basicInfo: { meetingCity: "延吉" } };
  const day = { day: 2, title: "延吉-长白山", spots: [{ name: "长白山" }] };
  const requests: ItineraryDayTitleRequest[][] = [];
  const result = await generateItineraryDayTitles({
    product: routeProduct, itinerary: [day], sourceText: () => "",
    generate: async (input) => {
      requests.push(input);
      return [{ day: 2, title: requests.length === 1 ? "延吉市区前往长白山" : "延吉-长白山" }];
    },
  });
  assert.match(requests[1]![0]!.rejectedReason ?? "", /途经点/u);
  assert.equal(result[0]!.title, "延吉-长白山");
  const names = ["延吉", ...Array.from({ length: 10 }, (_, index) => `景点${index}名称很长`)];
  const fitted = ensureDayTitleFits(routeProduct, { day: 2, title: names.join("-"), spots: names.slice(1).map((name) => ({ name })) });
  assert.match(String(fitted.title), /^延吉/u);
  assert.ok([...String(fitted.title)].length <= 70);
});

test("ensureDayTitleFits 只取首行并去句末标点，合格标题原样保留", () => {
  const raw = { day: 2, title: "万州-白帝城\n（建议：早去）", spots: [{ name: "白帝城" }] };
  assert.equal(ensureDayTitleFits(product, raw).title, "万州-白帝城");
  assert.equal(ensureDayTitleFits(product, itinerary[2]!), itinerary[2]!);
});

const privateProduct = { sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "延吉", destinationCity: "延吉", days: 2 } };
const privateItinerary = [
  { day: 1, title: "延吉-雪岭徒步", spots: [{ name: "雪岭" }] },
  { day: 2, title: "二道白河-长白山北坡", spots: [{ name: "长白山北坡" }] },
];

test("私家团与跟团游共用同一 70 字预算，不再有单独的 24 字与强制前缀", async () => {
  let seen: ItineraryDayTitleRequest[] = [];
  await generateItineraryDayTitles({
    product: privateProduct, itinerary: privateItinerary, sourceText: () => "",
    generate: async (requests) => { seen = requests; return []; },
  });
  assert.equal(seen[0]!.maxLength, 70 - "【出发地-延吉】".length);
  assert.equal(seen[1]!.maxLength, 70);
  assert.equal(itineraryDayTitleBudget(privateProduct, 2), ITINERARY_DAY_TITLE_MAX_LENGTH);
  assert.equal(itineraryDayTitleBudget({ sales: { productForm: "groupTour" } }, 2), ITINERARY_DAY_TITLE_MAX_LENGTH);
});

test("私家团标题直接采用新骨架，不再补专车服务前缀", async () => {
  const stayDay = { ...privateItinerary[1]!, hotel: "平台自动匹配", hotelCity: "安图" };
  const result = await generateItineraryDayTitles({
    product: privateProduct, itinerary: [stayDay], sourceText: () => "",
    generate: async () => [{ day: 2, title: "二道白河-长白山北坡-住二道白河【含雪岭门票】" }],
  });
  assert.equal(result[0]!.title, "二道白河-长白山北坡-住二道白河【含雪岭门票】");
});

test("住段与含项段按当天事实出现：有住宿才写住段，含项取自当天原文", () => {
  const withHotel = { day: 2, title: "二道白河-长白山北坡", spots: [{ name: "长白山北坡" }], hotel: "平台自动匹配", hotelCity: "安图" };
  assert.equal(dayTitleFacts(privateProduct, withHotel).stayAllowed, true);
  const facts = dayTitleFacts(privateProduct, { day: 2, title: "延吉-雪岭徒步", spots: [] });
  assert.equal(facts.stayAllowed, false);

  const requests: ItineraryDayTitleRequest[][] = [];
  return generateItineraryDayTitles({
    product: privateProduct,
    itinerary: [{ day: 2, title: "延吉-雪岭徒步", spots: [{ name: "雪岭" }] }],
    sourceText: () => "第2天 延吉-雪岭徒步，包含雪岭景区首道门票，住二道白河",
    generate: async (input) => { requests.push(input); return []; },
  }).then(() => {
    assert.ok(requests[0]![0]!.includeNotes.some((note) => note.includes("雪岭景区首道门票")), JSON.stringify(requests[0]![0]!.includeNotes));
  });
});

test("景点后的【配讲解】不当作当天含项尾缀", () => {
  const requests: ItineraryDayTitleRequest[][] = [];
  return generateItineraryDayTitles({
    product: privateProduct,
    itinerary: [{ day: 2, title: "日喀则-帕拉庄园", spots: [{ name: "帕拉庄园" }] }],
    sourceText: () => "第2天 火车站接-帕拉庄园【配讲解】-扎实伦布寺-送站",
    generate: async (input) => { requests.push(input); return []; },
  }).then(() => {
    assert.deepEqual(requests[0]![0]!.includeNotes, []);
  });
});

test("含项说明必须取自当天原文，凭空编造会被拦下并重试", async () => {
  const calls: ItineraryDayTitleRequest[][] = [];
  await generateItineraryDayTitles({
    product: privateProduct,
    itinerary: [{ day: 2, title: "延吉-雪岭徒步", spots: [{ name: "雪岭" }] }],
    sourceText: () => "第2天 延吉-雪岭徒步，包含雪岭景区首道门票",
    generate: async (input) => {
      calls.push(input);
      return [{ day: 2, title: "延吉-雪岭徒步【赠送长白山温泉票】" }];
    },
  });
  assert.match(calls[1]?.[0]?.rejectedReason ?? "", /含项说明须取自当天原文/u);
});

test("营销词只能出现在括号拓展里，玩法节点本身仍被拦", () => {
  const day = { day: 2, title: "延吉-网红打卡街", spots: [{ name: "雪岭" }] };
  const fitted = String(ensureDayTitleFits(privateProduct, day).title);
  assert.ok(!fitted.includes("网红"), fitted);
  assert.ok(fitted.includes("雪岭") || fitted.includes("延吉"), fitted);
});
