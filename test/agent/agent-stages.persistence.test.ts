import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { AgentSnapshotManager } from '../../src/main/agent/core-snapshot.js';

// Use only an isolated temporary SQLite database, never the user's product store.
test('SQLite readback retains stage summary, decision and associations after a manager restart', () => {
  const db = new VbkDatabase(mkdtempSync(path.join(tmpdir(), 'vbk-agent-stages-')));
  let id = 0;
  const clock = () => new Date('2026-10-03T00:00:00Z');
  const manager = new AgentSnapshotManager(db, clock, () => `s-${++id}`);
  const snapshot = manager.load('stage-fixture'); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'user', '帮我完善行程');
  manager.event(snapshot, 'input_request', '需要选择', { request: {
    id: 'q', createdAt: clock().toISOString(), questions: [{ id: 'pace', label: '节奏', kind: 'text', required: true }],
  }, stageSummary: '已检查行程，等待你决定节奏。' });
  manager.waiting(snapshot, 'waiting_input'); manager.save(snapshot);
  const readback = db.getAgentSnapshot('stage-fixture')!;
  assert.equal(readback.stages![0]!.summary, '已检查行程，等待你决定节奏。');
  const fresh = new AgentSnapshotManager(db, clock, () => `s-${++id}`).load('stage-fixture');
  manager.event(fresh, 'user', '用户回答', { requestId: 'q', answers: { pace: '轻松' } });
  manager.running(fresh); manager.save(fresh);
  const answered = db.getAgentSnapshot('stage-fixture')!;
  assert.equal(answered.stages![0]!.decision, '节奏：轻松');
  assert.equal(answered.stages![0]!.status, 'resolved');
  assert.equal(answered.stages![1]!.status, 'running');
  assert.equal(answered.events.at(-1)!.data!.stageId, answered.stages![1]!.id);
});
