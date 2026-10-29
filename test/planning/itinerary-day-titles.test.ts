import test from "node:test";
import assert from "node:assert/strict";
import { ReplayDataMissingError } from "../../src/main/infrastructure/replay-data-error.js";
import { ensureDayTitleFits, fallbackDayTitle, generateItineraryDayTitles, privateTourDayTitleFacts, type ItineraryDayTitleRequest } from "../../src/main/planning/itinerary-day-titles.js";
import { privateTourDayTitleProblem } from "../../src/shared/private-tour-day-title.js";
import { ITINERARY_DAY_TITLE_MAX_LENGTH, itineraryDayTitleBudget } from "../../src/shared/itinerary-day-title.js";
import { normaliseItineraryArrivalTitle } from "../../src/shared/itinerary-arrival-title.js";

const product = { basicInfo: { meetingCity: "万州", destinationCity: "万州", days: 3 } };
const itinerary = [
  { day: 1, title: "出发地 → 重庆万州，入住万州", spots: [] },
  { day: 2, title: "龙虹国家地质公园 · 张飞庙", spots: [{ name: "龙虹国家地质公园" }, { name: "张飞庙" }] },
  { day: 3, title: "白帝城 · 三峡之巅", spots: [{ name: "白帝城" }, { name: "三峡之巅" }] },
];

test("首日标题预算扣除【出发地-城市】前缀，最终写入长度不超过上限", () => {
  const budget = itineraryDayTitleBudget(product, 1);
  assert.equal(budget, ITINERARY_DAY_TITLE_MAX_LENGTH - "【出发地-万州】".length);
  const long = { day: 1, title: "甲".repeat(budget + 5), spots: [] };
  const fitted = ensureDayTitleFits(product, long);
  const saved = normaliseItineraryArrivalTitle({ ...product, itinerary: [fitted] }).itinerary as Array<{ title: string }>;
  assert.ok([...saved[0]!.title].length <= ITINERARY_DAY_TITLE_MAX_LENGTH);
});

test("AI 标题通过校验即采纳，并把每天的景点与预算传给 AI", async () => {
  let seen: ItineraryDayTitleRequest[] = [];
  const result = await generateItineraryDayTitles({
    product, itinerary, sourceText: () => "原文",
    generate: async (requests) => {
      seen = requests;
      return [
        { day: 1, title: "抵达万州 · 入住城区" },
        { day: 2, title: "云阳龙虹国家地质公园 · 张飞庙古迹" },
        { day: 3, title: "奉节白帝城 · 三峡之巅观景" },
      ];
    },
  });
  assert.deepEqual(result.map((day) => day.title), ["抵达万州 · 入住城区", "云阳龙虹国家地质公园 · 张飞庙古迹", "奉节白帝城 · 三峡之巅观景"]);
  assert.deepEqual(seen[1]!.requiredNames, ["龙虹国家地质公园", "张飞庙"]);
  assert.equal(seen[0]!.maxLength, itineraryDayTitleBudget(product, 1));
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
        ? { day: 2, title: "张飞庙 · 白帝城" } // 缺龙虹、串入第 3 天景点
        : request.day === 3 ? { day: 3, title: "白帝城 · 三峡之巅\n（建议早去）" } : { day: 1, title: "抵达万州" });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.map((request) => request.day), [2, 3]);
  assert.match(calls[1]![0]!.rejectedReason ?? "", /龙虹国家地质公园/u);
  assert.match(calls[1]![1]!.rejectedReason ?? "", /换行/u);
  assert.equal(result[0]!.title, "抵达万州");
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

test("兜底标题不在字符中间截断：保留完整景点名并注明总数", () => {
  const names = ["萨嘎", "仲巴五彩沙漠", "公珠措", "普兰境内主峰", "玛旁雍措", "拉昂措", "马泉河湿地", "纳木那尼峰"];
  const title = fallbackDayTitle({ day: 4, title: names.join(" · "), names, budget: 30 });
  assert.ok([...title].length <= 30, title);
  assert.match(title, /等8处景点$/u);
  for (const part of title.replace(/ · 等8处景点$/u, "").split(" · ")) assert.ok(names.includes(part), part);
  assert.equal(fallbackDayTitle({ day: 5, title: "甲".repeat(40), names: [], budget: 30 }), "第5天行程安排");
});

test("途经城市须保持独立路线节点，超长兜底也保留节点", async () => {
  const routeProduct = { basicInfo: { meetingCity: "延吉" } };
  const day = { day: 2, title: "延吉 · 长白山", spots: [{ name: "长白山" }] };
  const requests: ItineraryDayTitleRequest[][] = [];
  const result = await generateItineraryDayTitles({
    product: routeProduct, itinerary: [day], sourceText: () => "",
    generate: async (input) => {
      requests.push(input);
      return [{ day: 2, title: requests.length === 1 ? "延吉市区前往长白山" : "延吉 · 长白山" }];
    },
  });
  assert.match(requests[1]![0]!.rejectedReason ?? "", /途经点/u);
  assert.equal(result[0]!.title, "延吉 · 长白山");
  const names = ["延吉", ...Array.from({ length: 10 }, (_, index) => `景点${index}名称很长`)];
  const fitted = ensureDayTitleFits(routeProduct, { day: 2, title: names.join(" · "), spots: names.slice(1).map((name) => ({ name })) });
  assert.match(String(fitted.title), /^延吉 · /u);
  assert.ok([...String(fitted.title)].length <= 70);
});

test("ensureDayTitleFits 去掉换行与括号建议后再判断，合格标题原样保留", () => {
  const raw = { day: 2, title: "万州 → 返程。\n（建议：返程大交通自理。）\n\n【服务建议】专车", spots: [] };
  assert.equal(ensureDayTitleFits(product, raw).title, "万州 → 返程");
  assert.equal(ensureDayTitleFits(product, itinerary[2]!).title, itinerary[2]!.title);
});

const privateProduct = { sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "北京", destinationCity: "北京", days: 2 } };
const privateItinerary = [
  { day: 1, title: "故宫 · 天坛 · 颐和园", spots: [{ name: "故宫" }, { name: "天坛" }, { name: "颐和园" }] },
  { day: 2, title: "八达岭长城 · 十三陵", spots: [{ name: "八达岭长城" }, { name: "十三陵" }] },
];

test("私家团请求按 24 字预算并只把首个景点设为必含，跟团游仍是 70", async () => {
  let seen: ItineraryDayTitleRequest[] = [];
  await generateItineraryDayTitles({
    product: privateProduct, itinerary: privateItinerary, sourceText: () => "",
    generate: async (requests) => { seen = requests; return [{ day: 1, title: "专车服务｜故宫·天坛·颐和园" }, { day: 2, title: "专车服务｜八达岭长城·十三陵" }]; },
  });
  assert.equal(seen[0]!.maxLength, 24 - "【出发地-北京】".length);
  assert.equal(seen[1]!.maxLength, 24);
  assert.equal(seen[0]!.format, "privateTour");
  assert.deepEqual(seen[0]!.requiredNames, ["故宫"]);
  assert.deepEqual(seen[0]!.optionalNames, ["天坛", "颐和园"]);
  assert.equal(itineraryDayTitleBudget(privateProduct, 2), 24);
  assert.equal(itineraryDayTitleBudget({ sales: { productForm: "groupTour" } }, 2), ITINERARY_DAY_TITLE_MAX_LENGTH);
  let groupSeen: ItineraryDayTitleRequest[] = [];
  await generateItineraryDayTitles({ product, itinerary, sourceText: () => "", generate: async (requests) => { groupSeen = requests; return []; } });
  assert.equal(groupSeen[1]!.maxLength, 70);
  assert.equal(groupSeen[1]!.format, undefined);
});

test("私家团 AI 标题须带合法前缀，否则带原因重试", async () => {
  const calls: ItineraryDayTitleRequest[][] = [];
  const result = await generateItineraryDayTitles({
    product: privateProduct, itinerary: [privateItinerary[1]!], sourceText: () => "",
    generate: async (requests) => {
      calls.push(requests);
      return [{ day: 2, title: calls.length === 1 ? "包车服务｜八达岭长城" : "专车服务｜八达岭长城" }];
    },
  });
  assert.match(calls[1]![0]!.rejectedReason ?? "", /前缀/u);
  assert.equal(result[0]!.title, "专车服务｜八达岭长城");
});

test("私家团 ensureDayTitleFits：补专车服务前缀并裁到 24 字，只有真正的自由活动天补自由活动", () => {
  const fitted = ensureDayTitleFits(privateProduct, { day: 2, title: "八达岭长城 · 十三陵 · 居庸关 · 慕田峪长城", spots: ["八达岭长城", "十三陵", "居庸关", "慕田峪长城"].map((name) => ({ name })) });
  assert.match(String(fitted.title), /^专车服务｜八达岭长城/u);
  assert.ok([...String(fitted.title)].length <= 24, String(fitted.title));
  // 没有景点但也没有 free 活动：不能当作自由活动日（会丢用车卡片），用专车服务。
  assert.equal(ensureDayTitleFits(privateProduct, { day: 2, title: "北京市区", spots: [] }).title, "专车服务｜北京市区");
  const free = ensureDayTitleFits(privateProduct, { day: 2, title: "北京市区", spots: [{ name: "自由活动", kind: "free" }] });
  assert.equal(free.title, "自由活动｜北京市区");
  const ok = { day: 2, title: "专车服务｜八达岭长城·十三陵", spots: [] };
  assert.equal(ensureDayTitleFits(privateProduct, ok), ok);
});

test("私家团兜底：整句标题放不下时用当天景点重组，不写「第N天行程安排」", () => {
  const sentence = "八达岭长城" + "，登城远眺感受燕山雄关气势".repeat(3);
  const fitted = ensureDayTitleFits(privateProduct, { day: 2, title: sentence, spots: [{ name: "八达岭长城" }, { name: "十三陵" }] });
  assert.equal(fitted.title, "专车服务｜八达岭长城·十三陵");
  const empty = ensureDayTitleFits(privateProduct, { day: 2, title: "全天" + "自由安排休息".repeat(5), spots: [{ name: "自由活动", kind: "free" }] });
  // 自由活动天、原句放不下：节点「自由活动」本身就是当天事实。
  assert.equal(empty.title, "自由活动｜自由活动");
});

test("私家团兜底前缀：接送日按方向用专车前缀，含营销词的景点名原样保留", async () => {
  const pickup = ensureDayTitleFits(privateProduct, { day: 2, title: "抵达北京，专车接机后入住酒店休息", spots: [],
    activities: [{ time: "不限", title: "北京首都机场接机", detail: "专车接机前往酒店", type: "transport" }] });
  assert.match(String(pickup.title), /^专车接机｜/u);
  const both = ensureDayTitleFits(privateProduct, { day: 2, title: "北京", spots: [],
    activities: [{ time: "不限", title: "送机/送站", detail: "按航班或车次送机或送站", type: "transport" }] });
  assert.equal(both.title, "专车服务｜北京");
  const spot = ensureDayTitleFits(privateProduct, { day: 2, title: "经典艺术馆" + "，慢慢看展".repeat(5), spots: [{ name: "经典艺术馆" }] });
  assert.equal(spot.title, "专车服务｜经典艺术馆");
  const kept = await generateItineraryDayTitles({ product: privateProduct, itinerary: [{ day: 2, title: "经典艺术馆", spots: [{ name: "经典艺术馆" }] }],
    sourceText: () => "", generate: async () => [{ day: 2, title: "专车服务｜经典艺术馆" }] });
  assert.equal(kept[0]!.title, "专车服务｜经典艺术馆");
});

test("私家团：无景点时标题推导的节点不算事实，营销词照样拦；兜底丢掉该节点并保留途经点", async () => {
  const route = { sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "西安", destinationCity: "汉中", days: 3 } };
  const facts = privateTourDayTitleFacts(route, { day: 2, title: "专车服务｜网红打卡一条街", spots: [] });
  assert.match(privateTourDayTitleProblem("专车服务｜网红打卡一条街", 24, facts) ?? "", /营销词/u);
  const day = { day: 2, title: "专车服务｜西安-网红打卡街-汉中", spots: [] };
  assert.match(privateTourDayTitleProblem(day.title, 24, privateTourDayTitleFacts(route, day)) ?? "", /营销词/u);
  const fitted = String(ensureDayTitleFits(route, day).title);
  assert.equal(fitted, "专车服务｜西安-汉中");
  const calls: ItineraryDayTitleRequest[][] = [];
  await generateItineraryDayTitles({ product: route, itinerary: [day], sourceText: () => "",
    generate: async (requests) => { calls.push(requests); return [{ day: 2, title: day.title }]; } });
  assert.match(calls[1]?.[0]?.rejectedReason ?? "", /营销词/u);
});
