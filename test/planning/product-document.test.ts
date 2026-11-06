import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { extractProductDocument, discussProductDocument } from '../../src/main/planning/product-document.js';
import { validateIpcArguments } from '../../src/main/infrastructure/ipc-input.js';
import type { Settings } from '../../src/shared/contracts.js';
import { guardDocumentDialogueReply } from '../../src/main/planning/document-dialogue-guard.js';

const brief = { destination: '', productForm: '' as const, days: null, userIdea: '' };

test('PDF 提取文字层，损坏文件给出中文提示', async () => {
  const pdf = new Uint8Array(readFileSync(new URL('../fixtures/document/plain-itinerary.pdf', import.meta.url)));
  const extraction = await extractProductDocument('行程.pdf', pdf);
  assert.match(extraction.text, /D1 Xian Taibai Mountain/);
  await assert.rejects(extractProductDocument('坏.pdf', new Uint8Array([37, 80, 68, 70])), /PDF 解析失败/);
});

test('DOCX 提取正文，拒绝不支持的文件和空内容', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一天 奉节 三峡之巅</w:t></w:r></w:p></w:body></w:document>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  assert.match((await extractProductDocument('行程.docx', bytes)).text, /奉节 三峡之巅/);
  await assert.rejects(extractProductDocument('行程.doc', bytes), /DOCX/);
  await assert.rejects(extractProductDocument('行程.pdf', new Uint8Array()), /为空/);
});

test('IPC 限制文件大小及对话数据，拒绝额外字段', () => {
  assert.doesNotThrow(() => validateIpcArguments('document:discuss', [{ documentText: '行程', messages: [], brief }]));
  assert.throws(() => validateIpcArguments('document:discuss', [{ documentText: '行程', messages: [], brief, extra: 1 }]));
  assert.throws(() => validateIpcArguments('document:extract', ['x.pdf', new Uint8Array(10 * 1024 * 1024 + 1)]));
});

test('创建前多轮讨论传入文档、当前字段和既往对话，返回可审核建议', async () => {
  let request: any;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      request = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'submit_brief', arguments: JSON.stringify({ reply: '请确认住宿城市', destination: '奉节', productForm: 'groupTour', days: 2, itinerary: [{ day: 1, route: '', spots: ['三峡之巅'], meals: [], lodging: '' }, { day: 2, route: '', spots: ['夔州古城'], meals: ['早餐'], lodging: '' }] }) } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = { aiProvider: 'deepseek', deepseekBaseUrl: `http://127.0.0.1:${address.port}/v1`, deepseekModel: 'test', hasDeepSeekKey: true } as Settings;
    const result = await discussProductDocument({ getSettings: () => settings, apiKey: async () => 'test' }, { documentText: '第一天三峡之巅\n第二天夔州古城', brief, messages: [{ role: 'assistant', content: '是什么产品形态？' }, { role: 'user', content: '跟团游' }] });
    assert.equal(result.brief.productForm, 'groupTour');
    assert.equal(result.brief.userIdea, 'D1：三峡之巅（不含餐）\nD2：夔州古城（含早餐）');
    assert.equal(result.itinerary?.length, 2);
    assert.match(result.reply, /还需要你确认：接团城市/);
    assert.doesNotMatch(result.reply, /产品形态/);
    assert.match(request.messages[1].content, /第一天三峡之巅/);
    assert.equal(request.messages.at(-1).content, '跟团游');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('文档住宿记载冲突时不得把奉节作为已确定住宿，超长回复应自动重试', async () => {
  const documentText = '行程简表：\nDAY 1 出发地-奉节：三峡之巅-夔州古城-三峡拗口 住宿酒店 奉节\nDAY 2 奉节-巫山-出发地\n详细行程：\n第一天：出发地-奉节 餐：无 住宿：奉节/巫山\n游览三峡之巅。';
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      calls++;
      // 第一次漏掉第 2 天且编造景点，必须被本地校验拒绝并重试。
      const itinerary = calls === 1 ? [{ day: 1, route: '出发地-奉节', spots: ['三峡之巅', '白帝城'], meals: [], lodging: '奉节' }]
        : [{ day: 1, route: '出发地-奉节', spots: ['三峡之巅', '夔州古城', '三峡拗口'], meals: [], lodging: '奉节' },
          { day: 2, route: '奉节-巫山-出发地', spots: [], meals: [], lodging: '' }];
      const data = { reply: '已确认住宿奉节', destination: '', productForm: '', days: 2, itinerary };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'submit_brief', arguments: JSON.stringify(data) } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = { aiProvider: 'deepseek', deepseekBaseUrl: `http://127.0.0.1:${address.port}/v1`, deepseekModel: 'test', hasDeepSeekKey: true } as Settings;
    const result = await discussProductDocument({ getSettings: () => settings, apiKey: async () => 'test' }, { documentText, brief, messages: [{ role: 'user', content: '奉节接团、自由行。路线和全部服务尚待确认。' }] });
    assert.equal(calls, 2);
    assert.equal(result.brief.destination, '奉节'); assert.equal(result.brief.productForm, 'freeTravel');
    // 文档简表写奉节、详细行程写奉节/巫山：模型只给奉节也不能当作已确定，两城并列待确认。
    assert.equal(result.brief.userIdea, 'D1：【出发地-奉节】三峡之巅-夔州古城-三峡拗口-住奉节或巫山（不含餐）\nD2：【奉节-巫山-出发地】（不含餐）\n【待确认】第一晚住宿城市待确认：文档写奉节或巫山');
    assert.doesNotMatch(result.brief.userIdea, /白帝城/);
    assert.doesNotMatch(result.reply, /已确认住宿/);
    assert.match(result.reply, /住宿城市待确认.*奉节\/巫山/s);
    assert.doesNotMatch(result.reply, /原文路线摘录|均待确认/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('模型给出的路线不会写进规划想法，也不展示固定说明文案', async () => {
  const documentText = '详细行程：\n第一天：出发地-奉节\n前往【三峡之巅】，随后前往【夔州古城】。\n第二天：奉节-巫山\n游览【神女大扶梯】，随后前往【三峡龙脊】，中餐后返程。\n服务标准\n住宿待确认';
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const data = { reply: '请确认路线和服务', destination: '', productForm: '', days: 2, userIdea: '第一天三峡之巅、夔州古城；第二天中餐、神女大扶梯、三峡龙脊、额外游览白帝城。' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'submit_brief', arguments: JSON.stringify(data) } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = { aiProvider: 'deepseek', deepseekBaseUrl: `http://127.0.0.1:${address.port}/v1`, deepseekModel: 'test', hasDeepSeekKey: true } as Settings;
    const result = await discussProductDocument({ getSettings: () => settings, apiKey: async () => 'test' }, { documentText, brief, messages: [] });
    assert.equal(result.brief.userIdea, '第1天：出发地-奉节\n第2天：奉节-巫山');
    assert.doesNotMatch(result.brief.userIdea, /白帝城/);
    assert.doesNotMatch(result.reply, /白帝城|原文路线摘录|文档参考/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('对话回复不能调换路线、新增景点或擅自确认服务', async () => {
  const documentText = '详细行程：\n第一天：前往【三峡之巅】，随后前往【夔州古城】。\n第二天：前往【神女大扶梯】，随后前往【三峡龙脊】，中餐后返程。\n服务标准\n住宿待确认';
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const data = { reply: '第二天先中餐再去神女大扶梯，增加白帝城。已确认含酒店和门票。', destination: '', productForm: '', days: 2, userIdea: '路线待确认' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'submit_brief', arguments: JSON.stringify(data) } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = { aiProvider: 'deepseek', deepseekBaseUrl: `http://127.0.0.1:${address.port}/v1`, deepseekModel: 'test', hasDeepSeekKey: true } as Settings;
    const result = await discussProductDocument({ getSettings: () => settings, apiKey: async () => 'test' }, { documentText, brief, messages: [{ role: 'user', content: '请按原文说明路线和服务' }] });
    assert.doesNotMatch(result.reply, /白帝城|已确认含酒店/);
    assert.doesNotMatch(result.reply, /原文路线摘录|均待确认/);
    assert.match(result.reply, /请核对下方内容/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('服务对话只能引用完整原文行，拒绝模型增删和调换引用顺序', () => {
  const source = '详细行程：\n第一天：参观【甲】。\n服务标准\n住宿：商务酒店。\n门票：行程所列景点首道门票。';
  const result = guardDocumentDialogueReply('已确定含所有门票。', source, ['门票：行程所列景点首道门票。', '住宿：商务酒店。', '赠送飞机票。', '门票：行程所列景点']);
  assert.doesNotMatch(result, /已确定含所有门票|赠送飞机票/);
  assert.match(result, /文档服务原文摘录/);
  assert.ok(result.indexOf('住宿：商务酒店。') < result.indexOf('门票：行程所列景点首道门票。'));
  const fallback = guardDocumentDialogueReply('无法核实', source, [], '门票如何安排？');
  assert.match(fallback, /门票：行程所列景点首道门票。/);
  assert.doesNotMatch(fallback, /住宿：商务酒店。/);
});
