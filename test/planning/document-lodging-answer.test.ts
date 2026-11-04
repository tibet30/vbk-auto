import assert from 'node:assert/strict';
import test from 'node:test';
import { lodgingConflict, lodgingAnswer } from '../../src/main/planning/document-lodging-conflict.js';
import { documentRouteIdea } from '../../src/main/planning/document-route-idea.js';
import { guardDocumentDialogueReply } from '../../src/main/planning/document-dialogue-guard.js';

const doc = `行程简表：
DAY 	1 	出发地-奉节： 	三峡之巅-夔州古城 	0 	0 	0 	奉节
DAY 	2 	奉节-巫山-出发地： 	船行巫峡 	√ 	√ 	0 	温馨的家
详细行程：
第一天： 	出发地-奉节 	餐： 	无 	住宿： 	奉节/巫山
家乡出发。`;
const conflict = lodgingConflict(doc)!;
const user = (content: string) => ({ role: 'user' as const, content });

test('运营明确回答住宿城市时识别，限定在文档候选内', () => {
  assert.equal(lodgingAnswer([user('住奉节')], conflict), '奉节');
  assert.equal(lodgingAnswer([user('第一天住宿巫山')], conflict), '巫山');
  assert.equal(lodgingAnswer([user('奉节接团，跟团游'), user('住奉节')], conflict), '奉节');
});

test('疑问、否定、非候选城市都不算确认', () => {
  assert.equal(lodgingAnswer([user('住奉节吗？')], conflict), undefined);
  assert.equal(lodgingAnswer([user('不住奉节')], conflict), undefined);
  assert.equal(lodgingAnswer([user('住成都')], conflict), undefined);
  assert.equal(lodgingAnswer([{ role: 'assistant', content: '住奉节' }], conflict), undefined);
});

test('确认后规划想法写入运营确认的住宿，不再保留待确认提示', () => {
  const idea = documentRouteIdea(doc, '奉节');
  assert.match(idea, /第一天住宿城市：奉节/);
  assert.doesNotMatch(idea, /待确认/);
  assert.match(idea, /^第1天：出发地-奉节：三峡之巅-夔州古城$/m);
});

test('确认后回复说明已记录，不再重复冲突提示', () => {
  const reply = guardDocumentDialogueReply('x', doc, [], '住奉节', true, '奉节');
  assert.match(reply, /已记录第一天住宿城市：奉节/);
  assert.doesNotMatch(reply, /待确认/);
});
