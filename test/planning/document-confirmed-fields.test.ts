import assert from 'node:assert/strict';
import test from 'node:test';
import { protectDocumentFields } from '../../src/main/planning/document-confirmed-fields.js';

const empty = { destination: '', productForm: '' as const, days: null, userIdea: '' };
const proposed = { reply: '已确认重庆跟团游', brief: { destination: '重庆', productForm: 'groupTour' as const, days: 2, userIdea: '两天行程' } };
test('文档分析出的接团城市和产品形态直接写入，城市必须有原文依据', () => {
  const inferred = { ...proposed, brief: { ...proposed.brief, destination: '奉节' } };
  const result = protectDocumentFields({ documentText: '奉节、巫山两日游，空调旅游车', messages: [], brief: empty }, inferred);
  assert.equal(result.brief.destination, '奉节');
  assert.equal(result.brief.productForm, 'groupTour');
  const unsupported = protectDocumentFields({ documentText: '奉节、巫山两日游', messages: [], brief: empty }, proposed);
  assert.equal(unsupported.brief.destination, '');
  assert.equal(unsupported.brief.productForm, 'groupTour');
  assert.doesNotMatch(unsupported.reply, /已确认重庆/);
});
test('运营明确的城市和产品形态可以填写，否定选择不能当作确认', () => {
  const input = { documentText: '行程', messages: [{ role: 'user' as const, content: '确认接团城市为奉节，产品形态为自由行。' }], brief: empty };
  const result = protectDocumentFields(input, { ...proposed, brief: { ...proposed.brief, destination: '奉节', productForm: 'freeTravel' } });
  assert.equal(result.brief.destination, '奉节'); assert.equal(result.brief.productForm, 'freeTravel');
  const rejected = protectDocumentFields({ ...input, messages: [{ role: 'user', content: '不要跟团游，接团城市还未确认' }] }, proposed);
  assert.equal(rejected.brief.destination, ''); assert.equal(rejected.brief.productForm, '');
});
test('保留运营已手动填写的值，模型不能擅自覆盖', () => {
  const result = protectDocumentFields({ documentText: '行程', messages: [], brief: { ...empty, destination: '奉节', productForm: 'freeTravel' } }, proposed);
  assert.equal(result.brief.destination, '奉节'); assert.equal(result.brief.productForm, 'freeTravel');
});

test('疑问句不构成接团城市确认；产品形态按文档分析直接采用', () => {
  const result = protectDocumentFields({ documentText: '行程', messages: [{ role: 'user', content: '接团城市是重庆吗？产品形态可能是跟团游。' }], brief: empty }, proposed);
  assert.equal(result.brief.destination, '', '接团城市必须有原文依据或运营明确指定');
  assert.equal(result.brief.productForm, 'groupTour', '产品形态允许模型按服务特征分析，不再要求逐句确认');
});

test('简写确认与后续待确认事项分开，模型留空时仍识别奉节接团和自由行', () => {
  const input = { documentText: '文档', brief: empty, messages: [{ role: 'user' as const, content: '奉节接团、自由行。路线和全部服务尚待确认；请用简短文字列出住宿冲突及待确认事项，不要猜测。' }] };
  const output = protectDocumentFields(input, { reply: '请确认', brief: { ...empty, days: 2 } });
  assert.equal(output.brief.destination, '奉节');
  assert.equal(output.brief.productForm, 'freeTravel');
});

test('简写仅识别明确肯定的回答，后续变更优先', () => {
  const reply = { reply: '请确认', brief: { ...empty, days: 2 } };
  const uncertainInput = { documentText: '文档', brief: empty, messages: [{ role: 'user' as const, content: '可能奉节接团，自由行吗？' }] };
  assert.equal(protectDocumentFields(uncertainInput, reply).brief.destination, '');
  const revised = { ...uncertainInput, messages: [{ role: 'user' as const, content: '重庆接团、跟团游。' }, { role: 'user' as const, content: '奉节接团、自由行。' }] };
  const result = protectDocumentFields(revised, reply);
  assert.equal(result.brief.destination, '奉节'); assert.equal(result.brief.productForm, 'freeTravel');
});
