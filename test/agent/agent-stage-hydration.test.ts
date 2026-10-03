import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hydrateAgentStages } from '../../src/shared/agent-stage-lifecycle.js';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import type { AgentSnapshot } from '../../src/shared/contracts-agent.js';

function legacy(): AgentSnapshot {
  return { localProductId: 'hydration', run: null,
    events: Array.from({ length: 1916 }, (_, index) => ({ id: `e-${index}`, runId: 'r',
      type: index === 0 ? 'user' : 'assistant', content: '历史内容', createdAt: '2026-10-03T00:00:00Z' })) };
}

test('persisted hydration skips the historical prefix and associates only external tail events', () => {
  const snapshot = legacy(); hydrateAgentStages(snapshot);
  const stages = structuredClone(snapshot.stages);
  let reads = 0;
  snapshot.events = new Proxy(snapshot.events, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  hydrateAgentStages(snapshot);
  assert.ok(reads <= 3, `unchanged prefix read ${reads} times`);
  assert.deepEqual(snapshot.stages, stages);
  snapshot.events.push({ id: 'usage', runId: 'r', type: 'status', content: 'AI 用量',
    createdAt: '2026-10-03T00:01:00Z', data: { aiUsage: {} } });
  reads = 0; hydrateAgentStages(snapshot);
  assert.ok(reads <= 5, `appended tail read ${reads} times`);
  assert.equal(snapshot.events.at(-1)!.data!.stageId, stages![0]!.id);
  assert.equal(snapshot.stages![0]!.eventCount, 1917);
});

test('removed or replaced tail invalidates the cursor without duplicating stages', () => {
  for (const replace of [false, true]) {
    const snapshot = legacy(); hydrateAgentStages(snapshot);
    snapshot.events.pop();
    if (replace) snapshot.events.push({ id: 'replacement', runId: 'r', type: 'assistant',
      content: '新的回复', createdAt: '2026-10-03T00:02:00Z' });
    const fullScan = structuredClone(snapshot); delete fullScan.stageHydration;
    hydrateAgentStages(fullScan); hydrateAgentStages(snapshot);
    assert.deepEqual(snapshot, fullScan);
  }
});

test('legacy SQLite snapshots migrate once and retain the cursor after reopening', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vbk-hydration-'));
  let db = new VbkDatabase(directory);
  const snapshot = legacy();
  db.saveAgentSnapshot(snapshot);
  const first = db.getAgentSnapshot(snapshot.localProductId)!;
  assert.equal(first.stageHydration!.eventCount, 1916);
  db.close(); db = new VbkDatabase(directory);
  const reopened = db.getAgentSnapshot(snapshot.localProductId)!;
  assert.deepEqual(reopened, first);
  delete reopened.stages;
  hydrateAgentStages(reopened);
  assert.deepEqual(reopened.stages, first.stages);
  db.close();
});
