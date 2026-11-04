import assert from 'node:assert/strict';
import test from 'node:test';
import { missingFieldsPrompt } from '../../src/main/planning/document-missing-fields.js';

const full = { destination: '奉节', productForm: 'groupTour' as const, days: 2, userIdea: '' };

test('接团城市和产品形态都未确认时追问，并给出可选形态和回答示例', () => {
  const note = missingFieldsPrompt({ ...full, destination: '', productForm: '' });
  assert.match(note, /接团城市/);
  assert.match(note, /产品形态/);
  assert.match(note, /私家团.*跟团游.*自由行.*半自助游/s);
  assert.doesNotMatch(note, /天数/);
});

test('只追问缺失项，天数缺失也要提示', () => {
  const city = missingFieldsPrompt({ ...full, destination: '' });
  assert.match(city, /接团城市/); assert.doesNotMatch(city, /产品形态/);
  assert.match(missingFieldsPrompt({ ...full, days: null }), /天数/);
});

test('必填项齐全时不追问', () => {
  assert.equal(missingFieldsPrompt(full), '');
});

import { guardDocumentDialogueReply } from '../../src/main/planning/document-dialogue-guard.js';
import { discussProductDocument } from '../../src/main/planning/product-document.js';
import { createServer } from 'node:http';
import type { Settings } from '../../src/shared/contracts.js';

test('必填项齐全时回复给出下一步，不再抛出随机追问，仍保留住宿冲突提示', () => {
  const source = '行程简表\nDAY 1 奉节 奉节\n详细行程：\n第一天： 餐： 无 住宿： 奉节/巫山\n';
  const reply = guardDocumentDialogueReply('请确认门票和补费。', source, [], '奉节', true);
  assert.match(reply, /创建信息已齐全.*勾选.*确认并创建/s);
  assert.doesNotMatch(reply, /门票和补费/);
});

test('端到端：用户已回答接团城市和形态后，回复引导勾选核对并创建', async () => {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'submit_brief', arguments: JSON.stringify({ reply: '请确认门票和补费。', destination: '奉节', productForm: 'groupTour', days: 2, userIdea: '' }) } }] }, finish_reason: 'tool_calls' }] }));
  }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const a = server.address(); assert.ok(a && typeof a !== 'string');
    const settings = { aiProvider: 'deepseek', deepseekBaseUrl: `http://127.0.0.1:${a.port}/v1`, deepseekModel: 't', hasDeepSeekKey: true } as Settings;
    const brief = { destination: '奉节', productForm: 'groupTour' as const, days: 2, userIdea: '' };
    const result = await discussProductDocument({ getSettings: () => settings, apiKey: async () => 'k' },
      { documentText: '第一天三峡之巅', brief, messages: [{ role: 'user', content: '奉节接团，跟团游' }] });
    assert.match(result.reply, /创建信息已齐全/);
    assert.doesNotMatch(result.reply, /门票和补费|还需要你确认/);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
