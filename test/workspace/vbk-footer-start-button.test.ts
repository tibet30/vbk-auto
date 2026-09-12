import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const read=(path:string)=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
const vbk=read('src/renderer/app/views/workspace/vbk.tsx');
const workflow=read('src/renderer/app/actions/workflow.ts');
const conversation=read('src/renderer/app/views/workspace/agent-conversation.tsx');

test('VBK footer leads to the single final confirmation surface',()=>{
  const footer=vbk.slice(vbk.indexOf('<footer'),vbk.indexOf('</footer>'));
  assert.match(vbk,/const automationSucceeded = product\.automation\?\.status === "succeeded" && product\.status === "draft_saved"/);
  assert.match(footer,/aria-label="前往方案确认"/);
  assert.match(footer,/title="前往方案确认"/);
  assert.match(footer,/void startAutomation\(\)/);
  assert.match(workflow,/const startAutomation = async[\s\S]*?setStage\("review"\)/);
  assert.doesNotMatch(workflow,/automation\.(start|retryOnePhase)\(/);
  assert.match(conversation,/确认方案并录入 VBK/);
});
test('completed VBK automation shows saved state instead of confirmation action',()=>{
  const footer=vbk.slice(vbk.indexOf('<footer'),vbk.indexOf('</footer>'));
  assert.match(footer,/automationSucceeded \? \(/);
  assert.match(footer,/aria-label="草稿已保存到 VBK"/);
  assert.match(footer,/已保存草稿/);
  assert.match(footer,/automationSucceeded \? "已录入"/);
  assert.match(footer,/automationSucceeded \? " 草稿已保存到 VBK"/);
});
test('not-ready products can return to collaboration, active automation can pause',()=>{
  const button=vbk.slice(vbk.lastIndexOf('<button',vbk.indexOf('aria-label="前往方案确认"')),vbk.indexOf('aria-label="前往方案确认"'));
  assert.doesNotMatch(button,/!readiness.ready/);
  assert.match(vbk,/aria-label="停止自动录入"/);
  assert.match(vbk,/disabled=\{stoppingAutomation\}/);
  assert.match(workflow,/agent\.pause\(product.id\)/);
});
test('automation stage progress and authenticated browser controls remain visible',()=>{
  assert.match(vbk,/自动录入进度/);assert.match(vbk,/product\.automation\?\.currentPhase/);
  assert.match(vbk,/复制页面地址/);assert.match(vbk,/刷新当前页面/);
});
