import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('new shared contracts and projections do not depend on main process or renderer', () => {
  for (const path of ['src/shared/product-storage-projection.ts', 'src/shared/contracts-product-architecture.ts',
    'src/shared/contracts-platform-operations.ts']) {
    assert.doesNotMatch(source(path), /from\s+['"][^'"]*(?:main|renderer)\//);
  }
});

test('business tools use domain platform adapters and broadcasts never repair or write business state', () => {
  assert.doesNotMatch(source('src/main/agent/integration/tools.ts'),
    /from\s+['"][^'"]*(?:poi-suggest|vehicle-resource|hotel-resource|station-search|basic-info\/api)\.js/);
  assert.doesNotMatch(source('src/main/main-events.ts'),
    /(?:completeWorkflowTaskForProduct|saveAgentSnapshot|mergeAgentDiagnostics|remote\.update|createRemoteProductMirror)\(/);
  assert.doesNotMatch(source('src/main/application/product-task-scheduler.ts'), /runAutoConfirmedCreation/);
  assert.doesNotMatch(source('src/main/application/product-workspace-snapshot.ts'), /saveAgentSnapshot|updateProduct|updateWorkflowTask/);
});

test('changed and new source, test and document files respect the 350 line hard limit', () => {
  const tracked = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  for (const path of new Set((tracked + untracked).split('\0').filter(Boolean))) {
    if (!existsSync(resolve(root, path)) || !/\.(?:ts|tsx|cts|mjs|md)$/.test(path)) continue;
    const count = source(path).split('\n').length - Number(source(path).endsWith('\n'));
    assert.ok(count <= 350, `${path}: ${count} lines exceeds 350`);
  }
});
