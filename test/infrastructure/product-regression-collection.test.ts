import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REQUIRED_PRODUCT_SUITES, REQUIRED_PRODUCT_TESTS, assertProductReceipt, assertProductSuites } from '../../scripts/product-regression-contract.mjs';

const root = process.cwd();
const passed = () => REQUIRED_PRODUCT_TESTS.map(test => ({ ...test, status: 'test:pass', skip: false, todo: false }));

test('25 项执行收据必须完整、唯一、真实通过；少项、跳过、失败或错文件都失败', () => {
  assert.doesNotThrow(() => assertProductReceipt(root, passed()));
  for (const mode of ['missing', 'duplicate', 'skip', 'todo', 'fail', 'wrong_file']) {
    const records = passed();
    if (mode === 'missing') records.pop();
    if (mode === 'duplicate') records.push(records[0]);
    if (mode === 'skip') records[0].skip = true;
    if (mode === 'todo') records[0].todo = true;
    if (mode === 'fail') records[0].status = 'test:fail';
    if (mode === 'wrong_file') records[0].file = 'test/other.test.ts';
    assert.throws(() => assertProductReceipt(root, records), /强制产品回归/);
  }
  assert.throws(() => assertProductSuites(root, [REQUIRED_PRODUCT_SUITES[0]]), /缺少强制产品回归文件/);
});

// Stub tests verify the runner's enforcement only; real business E2E runs separately in the same regression.
for (const mutation of ['complete', 'missing_test', 'skip', 'todo', 'duplicate', 'missing_file']) {
  test(`真实 test:changed 运行器在 ${mutation} 情况下验证执行数量`, context => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'vbk-collection-'));
    context.after(() => rmSync(fixture, { recursive: true, force: true }));
    mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    mkdirSync(path.join(fixture, 'test/e2e'), { recursive: true });
    writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
    symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    for (const script of ['run-tests.mjs', 'test-selection.mjs', 'product-regression-contract.mjs', 'product-regression-reporter.mjs']) {
      copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    }
    for (const file of REQUIRED_PRODUCT_SUITES) {
      if (mutation === 'missing_file' && file === REQUIRED_PRODUCT_SUITES[1]) continue;
      const tests = REQUIRED_PRODUCT_TESTS.filter(test => test.file === file);
      const lines = tests.flatMap((entry, index) => {
        if (mutation === 'missing_test' && file === REQUIRED_PRODUCT_SUITES[1] && index === 0) return [];
        const method = file === REQUIRED_PRODUCT_SUITES[0] && index === 0 && ['skip', 'todo'].includes(mutation)
          ? `test.${mutation}` : 'test';
        const body = mutation === 'fail' && file === REQUIRED_PRODUCT_SUITES[0] && index === 0
          ? "() => { throw new Error('intentional product regression failure'); }"
          : '() => {}';
        const line = `${method}(${JSON.stringify(entry.name)}, ${body});`;
        return mutation === 'duplicate' && file === REQUIRED_PRODUCT_SUITES[0] && index === 0 ? [line, line] : [line];
      });
      writeFileSync(path.join(fixture, file), `// @test-layer e2e\nimport test from 'node:test';\n${lines.join('\n')}`);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', VBK_LIVE_E2E: '1' };
    delete env.NODE_TEST_CONTEXT;
    for (const mode of ['all', 'unit']) {
      const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', mode, '--changed'], {
        cwd: fixture, encoding: 'utf8', timeout: 15000,
        env,
      });
      assert.equal(result.error, undefined);
      if (mutation === 'complete') {
        assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
        assert.match(result.stdout, /5 项正向 \+ 20 项负向全部通过/);
      } else {
        assert.notEqual(result.status, 0, `${mode}/${mutation} 必须以失败退出`);
        assert.match(result.stderr, /强制产品回归/);
      }
    }
  });
}
