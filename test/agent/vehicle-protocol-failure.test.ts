import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolRunner } from '../../src/main/agent/core-tools.js';
import { AgentSnapshotManager } from '../../src/main/agent/core-snapshot.js';
import { PlatformOperationError } from '../../src/main/application/platform-operation-service.js';
import type { AgentSnapshot } from '../../src/shared/contracts.js';

for (const wrapped of [false, true]) {
  for (const deterministic of [false, true]) {
    test(`vehicle protocol failure stops both tools before parameter cycling (wrapped=${wrapped}, deterministic=${deterministic})`, async () => {
      let saved: AgentSnapshot = { localProductId: 'p', run: { id: 'r', status: 'running', createdAt: 'now', updatedAt: 'now' }, events: [] };
      let sequence = 0;
      let requests = 0;
      let repaired = false;
      const now = () => new Date('2026-10-11T00:00:00Z');
      const id = () => `id-${++sequence}`;
      const manager = new AgentSnapshotManager({ getAgentSnapshot: () => saved,
        saveAgentSnapshot: snapshot => { saved = structuredClone(snapshot); } }, now, id);
      const runner = new AgentToolRunner({ accountFor: async () => ({ accountKey: 'a', productVersion: 'v' }),
        tools: ['query_vehicle_resource', 'resolve_vehicle_resource'].map(name => ({ name, description: name, parameters: {},
          execute: async () => {
            requests++;
            if (repaired) return { content: '已核验' };
            const message = 'VBK 车辆资源查询协议解析失败：资源集合字段缺失；等待1秒';
            throw wrapped ? new PlatformOperationError(message, 'protocol_failure') : new Error(message);
          } })),
      }, manager, now, id);
      const execute = async (name: string, city: string) => {
        const call = { id: id(), name, arguments: { city } };
        const snapshot = manager.load('p');
        manager.event(snapshot, 'tool_call', name, { toolCallId: call.id, name, arguments: call.arguments,
          deterministicPreparation: deterministic });
        manager.save(snapshot);
        return runner.execute('p', call, { runId: 'r' });
      };
      assert.equal(await execute('query_vehicle_resource', '西安'), 'stale');
      const persisted = manager.load('p');
      assert.equal(persisted.run?.status, 'paused');
      assert.equal(persisted.pendingApproval, undefined);
      assert.equal(persisted.events.some(event => event.type === 'approval'), false);
      const failure = persisted.events.find(event => event.type === 'tool_result');
      assert.equal(failure?.data?.retryHint, 'after_protocol_fix');
      assert.equal(failure?.data?.protocolBlocked, true);
      assert.doesNotMatch(failure?.content ?? '', /最多再试一次/);
      assert.equal(await execute('query_vehicle_resource', '汉中'), 'stale');
      assert.equal(await execute('resolve_vehicle_resource', '宝鸡'), 'stale');
      assert.equal(requests, 1);
      assert.equal(manager.load('p').events.some(event => event.data?.waitSeconds), false);
      // An explicit continuation after repair may query again; pause is not a permanent lock.
      repaired = true;
      const resumed = manager.load('p');
      manager.running(resumed);
      manager.save(resumed);
      assert.equal(await execute('resolve_vehicle_resource', '西安'), 'continue');
      assert.equal(requests, 2);
    });
  }
}
