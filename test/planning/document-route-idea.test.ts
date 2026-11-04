import assert from 'node:assert/strict';
import test from 'node:test';
import { documentRouteIdea } from '../../src/main/planning/document-route-idea.js';

const sanxia = `行程简表：
天数 行程安排
早 餐
DAY 	1 	出发地-奉节： 	三峡之巅-夔州古城-三峡拗口 	0 	0 	0 	奉节
DAY 	2 	奉节-巫山-出发地： 	船行巫峡-船观神女峰-神女大扶梯-三峡龙脊-返程 	√ 	√ 	0 	温馨的家
详细行程：
第一天： 	出发地-奉节 	餐： 	无 	住宿： 	奉节/巫山
家乡出发前往奉节。`;

test('从行程简表按天摘出路线，去掉餐食和住宿列，并标出住宿冲突', () => {
  const idea = documentRouteIdea(sanxia);
  assert.match(idea, /^第1天：出发地-奉节：三峡之巅-夔州古城-三峡拗口$/m);
  assert.match(idea, /^第2天：奉节-巫山-出发地：船行巫峡-船观神女峰-神女大扶梯-三峡龙脊-返程$/m);
  assert.doesNotMatch(idea, /[√]|温馨的家|\b0\b/);
  assert.match(idea, /第一天住宿城市待确认.*奉节\/巫山/s);
});

test('没有简表时退回详细行程的每日标题，两者都没有时返回空', () => {
  assert.equal(documentRouteIdea('详细行程：\n第一天：出发地-奉节\n前往三峡之巅。\n第二天：奉节-巫山\n游览。'), '第1天：出发地-奉节\n第2天：奉节-巫山');
  assert.equal(documentRouteIdea('只是一段介绍'), '');
});

test('结果不超过 1000 字，按整行截断', () => {
  const text = Array.from({ length: 40 }, (_, i) => `DAY ${i + 1} ${'景点-'.repeat(40)} 0 0 0 酒店`).join('\n');
  const idea = documentRouteIdea(text);
  assert.ok(idea.length <= 1000);
  assert.ok(idea.split('\n').every(line => /^第\d+天：/.test(line)));
});
