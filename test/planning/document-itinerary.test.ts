import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyLodgingDecision, chineseOrdinal, chooseDocumentLodging, documentItineraryProblem, normaliseDocumentItinerary, pendingLodging, renderDocumentItinerary } from '../../src/main/planning/document-itinerary.js';
import { documentRouteIdea } from '../../src/main/planning/document-route-idea.js';
import { dailyRouteSources } from '../../src/main/agent/daily-route-source.js';
import { rawAlternativeGroups } from '../../src/main/planning/itinerary-input-contract/alternative.js';
import { hotelStayRequirement } from '../../src/shared/hotel-stay-requirement.js';

const doc = readFileSync(new URL('../fixtures/document/sanxia-red-3day.txt', import.meta.url), 'utf8');
const raw = [
  { day: 1, route: '全国各地-巫山', spots: ['【三峡龙脊】', '神女大扶梯'], meals: ['晚餐'], lodging: '巫山/奉节' },
  { day: 2, route: '巫山—奉节', spots: ['巫峡', '神女峰', '摩天岭', '三峡坳口', '三峡之巅'], meals: ['早餐', '下午茶'], lodging: '奉节' },
  { day: 3, route: '奉节-返程', spots: ['夔州古城'], meals: ['早餐'], lodging: '温馨的家' },
];

test('规范结构：去掉括号、统一连字符、过滤非规范餐食，返程日不保留住宿', () => {
  const plan = normaliseDocumentItinerary(raw);
  assert.deepEqual(plan[0], { day: 1, route: '全国各地-巫山', spots: ['三峡龙脊', '神女大扶梯'], meals: ['晚餐'], lodging: ['巫山', '奉节'] });
  assert.equal(plan[1]!.route, '巫山-奉节');
  assert.deepEqual(plan[1]!.meals, ['早餐']);
  assert.deepEqual(plan[2]!.lodging, []);
  assert.equal(documentItineraryProblem(plan, doc, 3), undefined);
});

test('校验：缺天、空安排、文档中不存在的景点都拒绝', () => {
  const plan = normaliseDocumentItinerary(raw);
  assert.match(documentItineraryProblem(plan.slice(0, 2), doc, 3)!, /第 1 至 3 天/);
  assert.match(documentItineraryProblem([plan[0]!, { ...plan[1]!, route: '', spots: [] }, plan[2]!], doc, 3)!, /第 2 天没有安排/);
  assert.match(documentItineraryProblem([plan[0]!, { ...plan[1]!, spots: ['白帝城'] }, plan[2]!], doc, 3)!, /白帝城.*没有出现在文档中/);
});

test('渲染：逐日一行；住宿二选一自动选择可住宿行政城市', () => {
  const plan = normaliseDocumentItinerary(raw);
  const pending = renderDocumentItinerary(plan, pendingLodging(plan), 1000);
  assert.equal(pending, [
    'D1：【全国各地-巫山】三峡龙脊-神女大扶梯-住巫山或奉节（含晚餐）',
    'D2：【巫山-奉节】巫峡-神女峰-摩天岭-三峡坳口-三峡之巅-住奉节（含早餐）',
    'D3：【奉节-返程】夔州古城（含早餐）',
    '【待确认】第一晚住宿城市待确认：文档写巫山或奉节',
  ].join('\n'));
  const confirmed = applyLodgingDecision(plan, 1, ['巫山', '奉节'], '巫山');
  const idea = renderDocumentItinerary(confirmed, pendingLodging(confirmed), 1000);
  assert.match(idea, /^D1：【全国各地-巫山】三峡龙脊-神女大扶梯-住巫山（含晚餐）$/m);
  assert.doesNotMatch(idea, /待确认/);
  assert.equal(chooseDocumentLodging(['白嘎乡', '比如县']), '比如');
  assert.equal(chooseDocumentLodging(['奉节', '巫山'], ['巫山']), '巫山');
  assert.equal(chooseDocumentLodging(['白嘎乡', '扎尕那村']), undefined, '都不是行政县市时交回待确认');
});

test('规范文本被下游逐日解析正确读取：待确认段不并入最后一天，住宿并列不锁成景点二选一', () => {
  const plan = normaliseDocumentItinerary(raw);
  const idea = renderDocumentItinerary(plan, pendingLodging(plan), 1000);
  assert.deepEqual(dailyRouteSources(idea).map(item => item.day), [1, 2, 3]);
  assert.doesNotMatch(dailyRouteSources(idea)[2]!.text, /待确认/);
  assert.deepEqual(rawAlternativeGroups(idea), []);
  const product = { basicInfo: { userIdea: idea, days: 3, nights: 2, meetingCity: '巫山' }, itinerary: [] };
  assert.equal(hotelStayRequirement(product, { day: 2 })?.anchorName, '奉节');
  assert.equal(hotelStayRequirement(product, { day: 3 }), undefined);
});

test('超长时先省略餐食，再整行截断，待确认事项始终保留', () => {
  const long = Array.from({ length: 12 }, (_, i) => ({ day: i + 1, route: '甲地-乙地', spots: Array.from({ length: 8 }, (_, j) => `景点${i}${j}号观景台`), meals: ['早餐' as const], lodging: [] as string[] }));
  const idea = renderDocumentItinerary(long, ['第一晚住宿城市待确认'], 1000);
  assert.ok(idea.length <= 1000);
  assert.doesNotMatch(idea, /含早餐/);
  assert.match(idea, /【待确认】第一晚住宿城市待确认$/);
  assert.equal(chineseOrdinal(12), '十二');
  assert.equal(chineseOrdinal(20), '二十');
});

test('兜底：PDF 拆散的简表缺天时改用详细行程标题，三天都有', () => {
  assert.equal(documentRouteIdea(doc), '第1天：全国各地-巫山\n第2天：巫山-奉节\n第3天：奉节-返程');
});
