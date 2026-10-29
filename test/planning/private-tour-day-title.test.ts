import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH,
  PRIVATE_TOUR_DAY_TITLE_PREFIXES,
  fitPrivateTourDayTitle,
  isFreeActivityDayTitle,
  privateTourDayTitleContent,
  privateTourDayTitleProblem,
} from "../../src/shared/private-tour-day-title.js";
import { isPersistedRouteTravelNode } from "../../src/shared/itinerary-route-travel-node.js";

const max = PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH;

test("私家团标题前缀白名单与 24 字上限", () => {
  assert.equal(max, 24);
  assert.deepEqual([...PRIVATE_TOUR_DAY_TITLE_PREFIXES], ["专车服务", "专车接机", "专车接站", "专车送机", "专车送站", "自由活动"]);
});

test("合格的私家团标题不报问题", () => {
  assert.equal(privateTourDayTitleProblem("专车服务｜故宫·景山公园·什刹海", max), undefined);
  assert.equal(privateTourDayTitleProblem("专车服务｜西安-华山·华清宫·兵马俑", max), undefined);
});

test("前缀、符号、景点数不合规都报问题", () => {
  for (const title of [
    "包车服务｜故宫",
    "故宫·天坛",
    "专车服务｜故宫😀·天坛",
    "专车服务｜【精华】故宫·天坛",
    "专车服务｜故宫（含讲解）",
    "专车服务｜故宫+天坛",
    "专车服务｜故宫→天坛",
    "专车服务｜网红打卡故宫",
    "专车服务｜故宫｜天坛",
    "专车服务｜",
    "专车服务｜故宫·天坛·颐和园·圆明园",
  ]) assert.ok(privateTourDayTitleProblem(title, max), title);
});

test("首日【出发地-城市】前缀计入 24 字：正好 24 字通过，多 1 字报超长", () => {
  const title = "【出发地-哈尔滨】专车接机｜抵达哈尔滨·入住酒店";
  assert.equal([...title].length, 24);
  assert.equal(privateTourDayTitleProblem(title, max), undefined);
  assert.match(privateTourDayTitleProblem("【出发地-哈尔滨】专车接机｜抵达哈尔滨·入住酒店区", max) ?? "", /超过/u);
});

test("超长标题从末尾删景点，保留前缀、第一个内容节点和途经节点", () => {
  const fitted = fitPrivateTourDayTitle("专车服务｜大理-丽江·双廊古镇·束河古镇·玉龙雪山", 20, ["丽江"]);
  assert.ok([...fitted].length <= 20, fitted);
  assert.ok(fitted.startsWith("专车服务｜大理"), fitted);
  assert.match(fitted, /-丽江/u);
  assert.equal(privateTourDayTitleProblem(fitted, 20), undefined);
  const keepLast = fitPrivateTourDayTitle("专车服务｜大理·双廊古镇·束河古镇·玉龙雪山-丽江", 16, ["丽江"]);
  assert.ok(keepLast.startsWith("专车服务｜大理") && keepLast.endsWith("丽江"), keepLast);
  assert.ok([...keepLast].length <= 16, keepLast);
});

test("裁剪后的途经节点仍能被 isPersistedRouteTravelNode 识别（Review Focus 1）", () => {
  const product = { basicInfo: { meetingCity: "大理", destinationCity: "丽江" } };
  const raw = "专车服务｜大理-丽江·双廊古镇·束河古镇·玉龙雪山";
  const fitted = fitPrivateTourDayTitle(raw, 20, ["大理", "丽江"]);
  const day = { day: 2, title: fitted, spots: [{ name: "双廊古镇" }] };
  assert.ok(isPersistedRouteTravelNode(product, day, "大理"), fitted);
  assert.ok(isPersistedRouteTravelNode(product, day, "丽江"), fitted);
});

test("用车卡片内容取「｜」之后；自由活动日识别", () => {
  assert.equal(privateTourDayTitleContent("专车服务｜故宫·天坛"), "故宫·天坛");
  assert.equal(privateTourDayTitleContent("【出发地-北京】专车接机｜抵达北京"), "抵达北京");
  assert.equal(privateTourDayTitleContent("故宫·天坛"), "故宫·天坛");
  assert.equal(isFreeActivityDayTitle("自由活动｜大理古城"), true);
  assert.equal(isFreeActivityDayTitle("【出发地-大理】自由活动｜大理古城"), true);
  assert.equal(isFreeActivityDayTitle("专车服务｜大理古城"), false);
});
