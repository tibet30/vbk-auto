import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

test('POI 删除须二次确认，取消和 Esc 不删除，确认携带正确目标', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error' });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/poi-delete-confirm-ui/index.html`);
    const deleteButton = page.getByRole('button', { name: '删除 POI：松花湖' });
    const dialog = page.getByRole('alertdialog', { name: '确认删除 POI' });
    await deleteButton.click();
    assert.equal(await page.getByText(/删除「松花湖」/).isVisible(), true);
    await dialog.getByRole('button', { name: '取消' }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).deletions), []);
    await deleteButton.click();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).deletions), []);
    await deleteButton.click();
    await dialog.getByRole('button', { name: '确认删除' }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).deletions), [{ target: { taskId: 't1' }, name: '松花湖' }]);
  } finally { await browser.close(); await server.close(); }
});
