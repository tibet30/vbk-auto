import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { extractLockedConstraints } from '../../src/main/agent/prompt-helpers.js';
import { daySection, daySections } from '../../src/main/planning/day-sections.js';

// 产品 4b10616c（吉林7天6晚私家团）的真实输入：天头用【第N天 城市】包裹，
// 逐日正文用 → 连接，末尾还跟着一段【服务包含建议】。修复前 D1 标题是
// 「吉林集合】24小时接机 · 入 【」，D7 标题被服务说明整段污染。
const JILIN = `【产品定位】7天吉林+延吉+牡丹江+雪乡+哈尔滨 私家团（含滑雪、温泉、冰捕、穿越等冬季体验）

【第1天 吉林集合】24小时接机→入住市区酒店→自由活动（建议不排行程，缓冲雪天路况与迟到）
【第2天 吉林—雾凇长廊—松花湖】雾凇长廊晨景→松花湖滑雪场（滑雪、雪圈）→云顶市集→入住二道河子温泉酒店（含温泉）
【第3天 二道河子—长白山北景区—延吉】雾凇漂流→长白山北景区（天池/长白瀑布/小天池/地下森林）→网红弹幕墙→延吉
【第4天 延吉—镜泊湖—牡丹江】延吉本地宝藏点+朝鲜族古村落→镜泊湖冰封冬捕+冰上娱乐→牡丹江
【第5天 牡丹江—横道河子—雪乡】横道河子百年小镇+机车库+油画村→雪乡轻旅拍→雪韵大街&棒槌山夜景+雪地蹦迪→宿雪乡
【第6天 雪乡—哈尔滨】雪域主峰秘境穿越（雪地摩托/轻徒步）→马拉爬犁体验→抵达哈尔滨
【第7天 哈尔滨】索菲亚教堂→中央大街→防洪纪念塔→中华巴洛克老道外→14:00送站/15:00抵达机场送机（建议预订17:00以后返程航班）

【服务包含建议】7天6晚住宿（1晚吉林、1晚二道河子温泉、1晚延吉、1晚牡丹江、2晚雪乡、1晚哈尔滨，按实际逐日核对）、全程专车、24小时接机与送机、行程内所列景点门票与体验、司导服务；不含雪乡景区大门票另计部分、正餐与滑雪装备租借等需在说明中单列。`;

const make = (userIdea: string, days = 7) =>
  buildProductSnapshot({ destination: '吉林', days, productForm: 'privateTour', userIdea });
const spotsOf = (userIdea: string, days = 7) =>
  extractLockedConstraints(make(userIdea, days)).itineraryOrder;

test('天头【第N天 城市】的括号不会进入任何景点名或标题', () => {
  const rows = spotsOf(JILIN);
  assert.deepEqual(rows.map((row) => row.day), [1, 2, 3, 4, 5, 6, 7]);
  for (const row of rows) {
    for (const name of row.spots) {
      assert.ok(!/[【】\n\r]/u.test(name), `D${row.day} 景点仍含括号或换行：${JSON.stringify(name)}`);
      assert.notEqual(name.trim(), '入', `D${row.day} 出现住宿段被削掉的残字`);
    }
  }
  // 天头是路线摘要，不再重复投影成景点；原始正文仍完整保留在 daySection。
  assert.ok(daySection(JILIN, 1).includes('吉林集合'));
  assert.ok(!rows[0]!.spots.includes('吉林集合'));
  assert.ok(rows[1]!.spots.includes('松花湖滑雪场'));
  assert.ok(rows[1]!.spots.includes('雾凇长廊晨景'));
  assert.ok(!rows[1]!.spots.includes('松花湖'));
  assert.ok(!rows[1]!.spots.includes('松花湖】雾凇长廊晨景'));
});

test('最后一天不会把【服务包含建议】整段服务说明当成当日景点', () => {
  const last = spotsOf(JILIN).at(-1)!;
  assert.deepEqual(last.spots, ['索菲亚教堂', '中央大街', '防洪纪念塔', '中华巴洛克老道外', '14:00送站', '15:00抵达机场送机']);
  assert.ok(!last.spots.some((name) => /服务包含建议|7天6晚|全程|司导服务/u.test(name)));
});

test('逐日正文不吞下一行行首的【，也不带孤立右括号', () => {
  const first = daySection(JILIN, 1);
  assert.ok(!first.includes('【'), `D1 正文带下一行行首方括号：${JSON.stringify(first)}`);
  assert.ok(first.includes('吉林集合'), '天头文字本身要保留为当日路线起点');
  // 最后一天同样不带下一段的【服务包含建议】。
  assert.ok(!daySection(JILIN, 7).includes('服务包含建议'));
  assert.deepEqual(daySections(JILIN).map((section) => section.day), [1, 2, 3, 4, 5, 6, 7]);
});

test('单行多天仍然按标记切分', () => {
  assert.deepEqual(daySections('D1 西宁-青海湖 D2 瓜州-敦煌').map((section) => section.day), [1, 2]);
  assert.deepEqual(spotsOf('D1 西宁-青海湖 D2 瓜州-敦煌', 2), [
    { day: 1, spots: ['西宁', '青海湖'] },
    { day: 2, spots: ['瓜州', '敦煌'] },
  ]);
});

test('跨行续行归入当前天，不被下一行截断丢弃', () => {
  assert.deepEqual(spotsOf('D1：西宁 - 青海湖\n- 茶卡盐湖\nD2：瓜州 - 敦煌', 2), [
    { day: 1, spots: ['西宁', '青海湖', '茶卡盐湖'] },
    { day: 2, spots: ['瓜州', '敦煌'] },
  ]);
});

test('行内【配讲解】标记不产生「配讲解」景点', () => {
  const rows = spotsOf('日喀则2日游\nD1、火车站接-帕拉庄园【配讲解】-白居寺-住日喀则\nD2、扎什伦布寺-送火车', 2);
  assert.ok(!rows.flatMap((row) => row.spots).includes('配讲解'));
  assert.ok(rows[0]!.spots.includes('帕拉庄园'));
});

test('住宿表达整段剔除：入住/宿/住 XX 不留残字，宿州这类地名保留', () => {
  const rows = spotsOf('D1：西宁→入住温泉酒店→青海湖\nD2：敦煌→宿雪乡\nD3：宿州→亳州', 3);
  assert.deepEqual(rows[0]!.spots, ['西宁', '青海湖']);
  assert.deepEqual(rows[1]!.spots, ['敦煌']);
  assert.ok(rows[2]!.spots.includes('宿州'));
});

// 产品 ae3316d7：【DAYN】天头 + 末尾【服务建议】【二选一待定】分节；分节正文里的
// 「DAY4」只是引用，不能被当成新的第 4 天，也不能让第 5 天吞下服务说明。
const WANZHOU = `【产品定位】重庆万州出发/进出，5天4晚私家团。

【DAY1】出发地 → 重庆万州，入住万州。
（建议：抵达后安排万州城区轻松游览，晚餐品尝万州烤鱼。）

【DAY4】巫峡 → 神女大扶梯，入住巫山或万州。

【DAY5】巫山或万州 → 返程。
（建议：住宿选万州则返程更从容。）

【服务建议】私家团含专车接送、独立用车与导游讲解。

【二选一待定】DAY4 住宿地：巫山 或 万州。`;

test('分节标题里的 DAYN 引用不产生新的一天，非末日也在分节标题处截断', () => {
  assert.deepEqual(daySections(WANZHOU).map((section) => section.day), [1, 4, 5]);
  const last = daySection(WANZHOU, 5);
  assert.ok(last.includes('返程'));
  assert.ok(!/服务建议|二选一待定|专车接送/u.test(last), JSON.stringify(last));
  assert.ok(!daySection(WANZHOU, 4).includes('住宿地'));
});
