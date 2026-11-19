import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY_TITLE_MAX_INCLUDE_LENGTH,
  DAY_TITLE_MAX_NODES,
  dayTitleGrammarProblem,
  dayTitleTransportCopy,
  isFreeActivityDayTitle,
  normaliseDayTitle,
  parseDayTitle,
  renderDayTitle,
} from "../../src/shared/day-title-grammar.js";
import { fitDayTitle } from "../../src/shared/day-title-fit.js";

const SAMPLE = "延吉-雪岭徒步-偶遇驯鹿-冰川夜钓(手摇网红小呲花)-住二道白河【包含雪岭景区首道门票】";
const budget = 70;

test("示例模板解析为起点、玩法节点、括号拓展、住段与含项", () => {
  const parsed = parseDayTitle(SAMPLE);
  assert.equal(parsed.arrival, "");
  assert.equal(parsed.start, "延吉");
  assert.deepEqual(parsed.nodes, [
    { name: "雪岭徒步", detail: "" },
    { name: "偶遇驯鹿", detail: "" },
    { name: "冰川夜钓", detail: "手摇网红小呲花" },
  ]);
  assert.equal(parsed.stay, "二道白河");
  assert.equal(parsed.includes, "包含雪岭景区首道门票");
});

test("渲染往返与解析一致", () => {
  assert.equal(renderDayTitle(parseDayTitle(SAMPLE)), SAMPLE);
});

test("括号拓展只属于紧邻的前一个点位", () => {
  const parsed = parseDayTitle("延吉-雪岭徒步-冰川夜钓(手摇网红小呲花)-住二道白河");
  assert.equal(parsed.nodes[0]!.name, "雪岭徒步");
  assert.equal(parsed.nodes[0]!.detail, "");
  assert.equal(parsed.nodes[1]!.name, "冰川夜钓");
  assert.equal(parsed.nodes[1]!.detail, "手摇网红小呲花");
  assert.ok(!parsed.nodes[0]!.detail);
});

test("合格标题不报问题：含项与住段按当天事实出现", () => {
  assert.equal(dayTitleGrammarProblem(SAMPLE, budget), undefined);
  assert.equal(dayTitleGrammarProblem("延吉-雪岭徒步-偶遇驯鹿", budget), undefined);
  assert.equal(dayTitleGrammarProblem("延吉-雪岭徒步-住二道白河", budget), undefined);
  assert.equal(dayTitleGrammarProblem("【出发地-延吉】延吉-雪岭徒步-住二道白河【含首道门票】", budget), undefined);
});

test("各类违规都被拦下且原因可读", () => {
  const cases: Array<[string, RegExp]> = [
    ["延吉-雪岭徒步+偶遇驯鹿", /\+|→/u],
    ["延吉-雪岭徒步→偶遇驯鹿", /\+|→/u],
    ["延吉-雪岭徒步/偶遇驯鹿", /「-」分隔/u],
    ["延吉-雪岭徒步、偶遇驯鹿", /「-」分隔/u],
    ["延吉-雪岭徒步 偶遇驯鹿", /「-」分隔/u],
    ["延吉-【精华】雪岭徒步", /【】/u],
    ["延吉-雪岭徒步-偶遇驯鹿-冰川夜钓", /超过/u],
  ];
  assert.match(dayTitleGrammarProblem("延吉-雪岭徒步-住二道白河😀", budget) ?? "", /emoji/u);
  assert.match(dayTitleGrammarProblem("延吉-雪岭徒步(手摇小呲花", budget) ?? "", /括号/u);
  for (const [title, pattern] of cases) {
    assert.match(dayTitleGrammarProblem(title, 12) ?? "", pattern, title);
  }
});

test("括号拓展必须紧跟点位之后、非空、有长度上限", () => {
  assert.match(dayTitleGrammarProblem("延吉-(手摇小呲花)雪岭徒步", budget) ?? "", /紧跟/u);
  assert.match(dayTitleGrammarProblem("延吉-雪岭徒步()", budget) ?? "", /不能为空/u);
  assert.match(dayTitleGrammarProblem("延吉-雪岭徒步(手摇网红小呲花超长拓展说明)", budget) ?? "", /超过/u);
  assert.match(dayTitleGrammarProblem("延吉-雪岭徒步(甲(乙))", budget) ?? "", /每段最多一个括号拓展|成对/u);
});

test("段数上限与含项说明长度上限按常量生效", () => {
  const nodes = Array.from({ length: DAY_TITLE_MAX_NODES + 1 }, (_, index) => `玩法${index}`);
  assert.match(dayTitleGrammarProblem(`起点-${nodes.join("-")}`, budget) ?? "", /最多/u);
  const long = "含".repeat(DAY_TITLE_MAX_INCLUDE_LENGTH + 1);
  assert.match(dayTitleGrammarProblem(`起点-玩法【${long}】`, budget) ?? "", /含项说明/u);
});

test("当天没有住宿事实时不能写住段", () => {
  assert.match(dayTitleGrammarProblem("延吉-雪岭徒步-住二道白河", budget, { stayAllowed: false }) ?? "", /没有住宿事实/u);
  assert.equal(dayTitleGrammarProblem("延吉-雪岭徒步-住二道白河", budget, { stayAllowed: true }), undefined);
});

test("非自由活动日不能只写自由活动", () => {
  assert.match(dayTitleGrammarProblem("延吉-自由活动", budget, { freeActivityOnly: false }) ?? "", /自由活动/u);
  assert.equal(dayTitleGrammarProblem("延吉-自由活动", budget, { freeActivityOnly: true }), undefined);
});

test("起点与玩法节点不能重复，节点之间也不能重复", () => {
  assert.match(dayTitleGrammarProblem("潮汕送团-潮汕送团", budget) ?? "", /与起点重复/u);
  assert.match(dayTitleGrammarProblem("潮汕-宽窄巷子-宽窄巷子", budget) ?? "", /不能重复/u);
  assert.equal(dayTitleGrammarProblem("潮汕-宽窄巷子-武侯祠", budget), undefined);
});

test("括号拓展不能塞入当天其他景点", () => {
  const facts = { allowedNames: ["青澳湾", "北回归线", "冰川夜钓"] };
  assert.match(dayTitleGrammarProblem("南澳岛-青澳湾(北回归线)", budget, facts) ?? "", /塞入其他景点/u);
  assert.equal(dayTitleGrammarProblem("南澳岛-青澳湾", budget, facts), undefined);
  assert.equal(dayTitleGrammarProblem("延吉-冰川夜钓(手摇网红小呲花)", budget, facts), undefined);
});

test("分隔符与括号统一规范化，不保留全角破折号", () => {
  assert.equal(normaliseDayTitle("西安接团—太白山唐镇—泡温泉"), "西安接团-太白山唐镇-泡温泉");
  assert.equal(normaliseDayTitle("延吉-冰川夜钓（手摇小呲花）"), "延吉-冰川夜钓(手摇小呲花)");
});

test("玩法节点不能塞营销词，事实名原样放行", () => {
  assert.match(dayTitleGrammarProblem("延吉-网红打卡一条街", budget) ?? "", /营销词/u);
  assert.equal(dayTitleGrammarProblem("延吉-网红打卡一条街", budget, { allowedNames: ["网红打卡一条街"] }), undefined);
});

test("旧「专车服务｜」标题仍可解析，前缀被剥离", () => {
  const parsed = parseDayTitle("专车服务｜西安-汉中");
  assert.equal(parsed.start, "西安");
  assert.deepEqual(parsed.nodes.map((node) => node.name), ["汉中"]);
  assert.equal(renderDayTitle(parsed), "西安-汉中");
  assert.equal(dayTitleTransportCopy("专车服务｜西安-汉中"), "西安-汉中");
});

test("用车卡片文案剥掉首日前缀、住宿段与含项段", () => {
  assert.equal(dayTitleTransportCopy(SAMPLE), "延吉-雪岭徒步-偶遇驯鹿-冰川夜钓(手摇网红小呲花)");
  assert.equal(dayTitleTransportCopy("【出发地-延吉】延吉-雪岭徒步-住二道白河"), "延吉-雪岭徒步");
});

test("自由活动日识别同时兼容新骨架与旧前缀", () => {
  assert.equal(isFreeActivityDayTitle("自由活动｜大理古城"), true);
  assert.equal(isFreeActivityDayTitle("【出发地-大理】自由活动｜大理古城"), true);
  assert.equal(isFreeActivityDayTitle("大理-自由活动"), true);
  assert.equal(isFreeActivityDayTitle("专车服务｜大理古城"), false);
  assert.equal(isFreeActivityDayTitle(SAMPLE), false);
});

test("超长时从末尾删玩法节点，保留起点与途经节点", () => {
  const fitted = fitDayTitle("大理-双廊古镇-束河古镇-玉龙雪山-丽江", 20, ["丽江"]);
  assert.ok([...fitted].length <= 20, fitted);
  assert.ok(fitted.startsWith("大理"), fitted);
  assert.ok(fitted.endsWith("丽江"), fitted);
  assert.equal(dayTitleGrammarProblem(fitted, 20), undefined);
});

test("超长时先舍含项再舍住段，最后才动玩法节点", () => {
  const fitted = fitDayTitle("延吉-雪岭徒步-偶遇驯鹿-住二道白河【包含雪岭景区首道门票】", 20, []);
  assert.ok([...fitted].length <= 20, fitted);
  assert.ok(fitted.includes("雪岭徒步"), fitted);
  assert.ok(!fitted.includes("包含雪岭景区首道门票"), fitted);
  assert.equal(dayTitleGrammarProblem(fitted, 20), undefined);
});

test("裁剪不会切断括号拓展", () => {
  const fitted = fitDayTitle("延吉-雪岭徒步-冰川夜钓(手摇网红小呲花)-住二道白河", 24, []);
  assert.ok(fitted.includes("冰川夜钓(手摇网红小呲花)"), fitted);
  assert.equal(dayTitleGrammarProblem(fitted, 24), undefined);
});
