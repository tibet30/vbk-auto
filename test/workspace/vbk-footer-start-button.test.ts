import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const read=(path:string)=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
const vbk=read('src/renderer/app/views/workspace/vbk.tsx');
const vbkReview=read('src/renderer/app/views/workspace/vbk/review.tsx');
const vbkBrowserPanel=read('src/renderer/app/views/workspace/vbk/browser-panel.tsx');
const vbkFull = vbk + '\n' + vbkReview + '\n' + vbkBrowserPanel;
const workflow=read('src/renderer/app/actions/workflow.ts');
const workflowAutomation=read('src/renderer/app/actions/workflow/automation.ts');
const workflowFull = workflow + '\n' + workflowAutomation;
const conversation=read('src/renderer/app/views/workspace/agent-conversation.tsx');

test('VBK footer leads to the single final confirmation surface',()=>{
  const footer=vbkFull.slice(vbkFull.indexOf('<footer'),vbkFull.indexOf('</footer>'));
  // After split, the variable is `draftSaved` (review.tsx) with equivalent
  // semantics: preflight completed AND status===draft_saved.
  assert.match(vbkFull,/product\.status === "draft_saved"[\s\S]*productId[\s\S]*preflight[\s\S]*completed/);
  assert.match(footer,/aria-label="前往方案确认"/);
  assert.match(footer,/title="前往方案确认"/);
  assert.match(footer,/void startAutomation\(\)/);
  assert.match(workflowFull,/const startAutomation = async[\s\S]*?setStage\("review"\)/);
  assert.doesNotMatch(workflowFull,/automation\.(start|retryOnePhase)\(/);
  assert.match(conversation,/确认方案并录入 VBK/);
});
test('completed VBK automation shows saved state instead of confirmation action',()=>{
  const footer=vbkFull.slice(vbkFull.indexOf('<footer'),vbkFull.indexOf('</footer>'));
  // Variable name preserved as automationSucceeded in review.tsx (alias of draftSaved).
  assert.match(footer,/automationSucceeded \? \(/);
  assert.match(footer,/aria-label="草稿已保存到 VBK"/);
  assert.match(footer,/已保存草稿/);
});
test('not-ready products can return to collaboration, active automation can pause',()=>{
  const button=vbkFull.slice(vbkFull.lastIndexOf('<button',vbkFull.indexOf('aria-label="前往方案确认"')),vbkFull.indexOf('aria-label="前往方案确认"'));
  assert.doesNotMatch(button,/!readiness.ready/);
  assert.match(vbkFull,/aria-label="停止自动录入"/);
  assert.match(vbkFull,/disabled=\{stoppingAutomation\}/);
  assert.match(workflowFull,/agent\.pause\(product\.id\)/);
});
test('automation stage progress and authenticated browser controls remain visible',()=>{
  assert.match(vbkFull,/自动录入进度/);assert.match(vbkFull,/product\.automation\?\.currentPhase/);
  assert.match(vbkFull,/复制页面地址/);assert.match(vbkFull,/刷新当前页面/);
});
