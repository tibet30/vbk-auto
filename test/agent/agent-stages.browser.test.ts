import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Real renderer controls; network and product writes use the isolated fixture.
test('A interaction: checkpoint, durable decision, continuous output, final summary and history reading', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-ui/index.html`);
    await page.getByRole('article', { name: '阶段总结' }).waitFor();
    const process = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '查看本阶段全部过程' }) }).first();
    assert.equal(await process.getAttribute('open'), null);
    assert.equal(await page.getByText('已查询景点与酒店资源，需要你决定行程节奏并补充文案。回答后继续完善方案。', { exact: true }).isVisible(), true);
    await process.locator('summary').first().click();
    assert.equal(await page.getByText('我会先核查适合的景点和酒店，再完善右侧行程。', { exact: true }).isVisible(), true);
    assert.equal(await process.locator('details[data-expanded="true"]').first().getAttribute('open'), '');
    await page.getByRole('button', { name: '轻松一些', exact: true }).click();
    await page.getByRole('textbox', { name: '请补充你希望保留的文案' }).fill('慢慢旅行');
    await page.getByRole('button', { name: '提交回答并继续' }).click();
    await page.getByRole('button', { name: '确认方案并录入 VBK' }).waitFor();
    assert.match(await page.getByRole('article', { name: '阶段总结', exact: true }).innerText(), /行程节奏|希望每天怎样安排/);
    assert.match(await page.getByRole('article', { name: '阶段总结', exact: true }).innerText(), /轻松一些/);
    assert.equal(await page.getByRole('button', { name: '提交回答并继续' }).count(), 0);
    await page.screenshot({ path: '/tmp/vbk-agent-a-decision.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    // Long checkpoint prose must remain scrollable above the fixed composer.
    await page.evaluate(() => {
      const fixture = (window as any).agentFixture;
      fixture.snapshot().stages.at(-1).summary = Array.from({ length: 20 }, (_, i) => `核验事项 ${i + 1}：行程和酒店候选已整理，需要确认下一步。`).join('\n\n');
      fixture.emit();
    });
    const approve = page.getByRole('button', { name: '确认方案并录入 VBK' });
    await approve.scrollIntoViewIfNeeded();
    await approve.click({ trial: true });
    const placement = await approve.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const log = document.querySelector('[role="log"]')!;
      const visible = log.getBoundingClientRect();
      return { height: rect.height, inside: rect.top >= visible.top && rect.bottom <= visible.bottom,
        hit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
        scrollable: log.scrollHeight > log.clientHeight };
    });
    assert.ok(placement.height >= 36 && placement.inside && placement.hit && placement.scrollable);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/vbk-agent-a-narrow-approval.png' });
    await approve.click();
    await page.getByRole('status').filter({ hasText: '已进入 VBK 录入' }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => (window as any).agentFixture.streamMessage('正在核对本次结果'));
    await page.getByText('正在核对本次结果', { exact: true }).waitFor();
    await page.evaluate(() => (window as any).agentFixture.streamMessage('本次核验完成，已保留你的行程选择。', true));
    await page.evaluate(() => (window as any).agentFixture.completeTask());
    const final = page.getByRole('article', { name: '任务最终总结' });
    await final.waitFor(); assert.match(await final.innerText(), /本次核验完成/);
    assert.match(await final.innerText(), /用户已授权/);
    await page.screenshot({ path: '/tmp/vbk-agent-a-final.png', fullPage: true });
    // Reading history must not be moved by a fresh event.
    await page.locator('[role="log"]').evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => (window as any).agentFixture.emitMessage('新的补充进展'));
    await page.getByRole('button', { name: '有新消息 · 回到最新' }).waitFor();
    const scrollTop = await page.locator('[role="log"]').evaluate((node) => node.scrollTop);
    assert.ok(scrollTop < 5);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/vbk-agent-a-narrow.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});

test('persisted stages reuse events; legacy migration copies without modifying input', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-ui/index.html`);
    const result = await page.evaluate(async () => {
      const { visibleAgentStages } = await import('/src/renderer/app/views/workspace/agent-stage-timeline.tsx');
      const snapshot = structuredClone((window as any).agentFixture.snapshot());
      // Copying event properties on the persisted fast path is unnecessary.
      Object.defineProperty(snapshot.events[0], 'copyProbe', { enumerable: true, get() { throw new Error('event copied'); } });
      const groups = visibleAgentStages(snapshot, snapshot.events, true);
      const sameEvent = groups[0].events[0] === snapshot.events[0];
      const sameStage = groups[0].stage === snapshot.stages[0];
      const legacy = structuredClone((window as any).agentFixture.snapshot());
      delete legacy.stages; legacy.events.forEach((event: any) => { delete event.data?.stageId; });
      const before = JSON.stringify(legacy);
      const migrated = visibleAgentStages(legacy, legacy.events, true);
      return { sameEvent, sameStage, unchanged: before === JSON.stringify(legacy), migrated: migrated.length > 0 && !!migrated[0].events[0].data.stageId };
    });
    assert.deepEqual(result, { sameEvent: true, sameStage: true, unchanged: true, migrated: true });
  } finally { await browser.close(); await server.close(); }
});
