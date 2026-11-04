import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

test('上传文档后多轮讨论，修改并确认信息后才创建产品', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error' });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/document-create-ui/index.html`);
    await page.getByRole('button', { name: '从文档创建' }).click();
    assert.equal(await page.getByRole('button', { name: '从文档创建' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '确认并创建' }).isDisabled(), true);
    await page.locator('input[type=file]').setInputFiles({ name: '行程.pdf', mimeType: 'application/pdf', buffer: Buffer.from('sample') });
    await page.getByText('请确认接团城市和产品形态').waitFor();
    await page.getByLabel('向 AI 补充或提问').fill('重庆接团，跟团游');
    await page.getByRole('button', { name: '发送' }).click();
    await page.getByText('已整理，请核对').waitFor();
    assert.equal(await page.getByRole('textbox', { name: '接团城市 必填' }).inputValue(), '重庆');
    const sizes = await page.evaluate(() => { const idea = document.querySelector('textarea[rows="7"]')!; const question = document.querySelector('textarea[aria-label="向 AI 补充或提问"]')!; const city = document.querySelector('input[placeholder="例如：重庆"]')!; return { idea: idea.getBoundingClientRect().height, question: question.getBoundingClientRect().height, city: city.getBoundingClientRect().height, padding: getComputedStyle(idea).paddingLeft }; });
    assert.ok(sizes.idea >= 140 && sizes.idea <= 160 && sizes.question >= 64 && sizes.city >= 36);
    assert.equal(sizes.padding, '12px');
    await page.getByRole('textbox', { name: /^规划想法/ }).fill('第一天三峡之巅；第二天巫峡');
    await page.getByRole('button', { name: '确认并创建' }).click();
    assert.match(await page.getByRole('alert').textContent() ?? '', /请先勾选/);
    assert.equal(await page.evaluate(() => (window as any).created), undefined);
    await page.getByLabel('我已核对以上创建信息').check();
    await page.getByRole('button', { name: '确认并创建' }).click();
    const created = await page.evaluate(() => (window as any).created);
    assert.deepEqual(created, { destination: '重庆', productForm: 'groupTour', days: 2, userIdea: '第一天三峡之巅；第二天巫峡' });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});


test('拖放文档并拒绝多文件，保留已读取文件', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error' });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/document-create-ui/index.html`);
    await page.getByRole('button', { name: '从文档创建' }).click();
    const zone = page.locator('[data-dragging]');
    const first = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['test'], '拖放行程.pdf', { type: 'application/pdf' })); return transfer; });
    await zone.dispatchEvent('dragover', { dataTransfer: first });
    assert.equal(await zone.getAttribute('data-dragging'), 'true');
    await zone.dispatchEvent('drop', { dataTransfer: first });
    await page.getByText('拖放行程.pdf').waitFor();
    const multiple = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['a'], 'a.pdf')); transfer.items.add(new File(['b'], 'b.pdf')); return transfer; });
    await zone.dispatchEvent('drop', { dataTransfer: multiple });
    assert.equal(await page.getByRole('alert').textContent(), '每次请选择一份文档。');
    assert.equal(await page.getByText('拖放行程.pdf').isVisible(), true);
    assert.equal(await page.getByLabel('选择行程文档').isEnabled(), true);
  } finally { await browser.close(); await server.close(); }
});
