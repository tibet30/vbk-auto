import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitOriginalRouteDecision } from '../../src/main/planning/poi-route-location.js';

type Json = Record<string, any>;

/** 运营原文里「| 宿X」「| 张掖结束行程」是同一行路线的一部分，竖线是停靠点边界。 */
const product = (): Json => ({
  basicInfo: { userIdea: [
    'D1：西宁 — 仙米国家森林公园 — 达坂山观景台 | 宿门源',
    'D2：门源 — 岗什卡雪峰 — 阿咪东索景区 | 宿祁连',
    'D3：祁连 — 祁连 9 号公路 — 祁连黑河源 | 宿肃南',
    'D4：祁连 — 巴尔斯雪山 - 七彩丹霞 | 张掖结束行程',
  ].join('\n') },
  itinerary: [
    { day: 1, spots: [{ name: '西宁' }, { name: '仙米国家森林公园' }, { name: '达坂山观景台' }] },
    { day: 2, spots: [{ name: '门源' }, { name: '岗什卡雪峰' }, { name: '阿咪东索景区' }] },
    { day: 3, spots: [{ name: '祁连' }, { name: '祁连 9 号公路' }, { name: '祁连黑河源' }] },
    { day: 4, spots: [{ name: '祁连' }, { name: '巴尔斯雪山' }, { name: '七彩丹霞' }] },
  ],
});

const candidate = (poiName: string, province: string, city: string) => ({
  index: 0, poiId: 1, poiName, province, city, district: city, selectable: true, textFields: [],
});

test('紧跟竖线的当天最后一个景点仍能拿到原文路线证据', () => {
  const value = product();
  // 修复前这四个停靠点的后边界是「|」，不在分隔符集合里，一律拿不到原文证据。
  for (const [keyword, province, city] of [
    ['达坂山观景台', '青海', '门源'],
    ['阿咪东索景区', '青海', '祁连'],
    ['祁连黑河源', '青海', '祁连'],
  ] as const) {
    const spot = candidate(keyword, province, city);
    assert.equal(explicitOriginalRouteDecision(value, keyword, spot, [spot]), 'allow', keyword);
  }
});

test('竖线后的结束城市可以替跨省尾段景点作证', () => {
  const value = product();
  const spot = candidate('七彩丹霞', '甘肃', '张掖');
  // 第 4 天路线写的是「祁连 — 巴尔斯雪山 - 七彩丹霞 | 张掖结束行程」，
  // 景点确实落在张掖；拿不到这条证据时会被判成「外省」而无法绑定。
  assert.equal(explicitOriginalRouteDecision(value, '七彩丹霞', spot, [spot]), 'allow');
  // 原文没写到的城市不能被这条证据顺带放行。
  const unmentioned = candidate('七彩丹霞', '甘肃', '兰州');
  assert.notEqual(explicitOriginalRouteDecision(value, '七彩丹霞', unmentioned, [unmentioned]), 'allow');
});
