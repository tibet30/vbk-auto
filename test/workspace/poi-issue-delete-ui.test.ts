import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenIssueRows } from '../../src/renderer/app/views/workspace/review-summary-open-issues.helpers.js';
import type { ProductDetail, ResearchTask } from '../../src/shared/contracts-types.js';

const product = {
  id: 'p1',
  product: { itinerary: [
    { day: 1, spots: [{ name: '自由活动', kind: 'free' }] },
    { day: 2, spots: [{ name: '松花湖', kind: 'attraction' }, { name: '云顶市集', kind: 'attraction', poiName: '云顶市集', poiId: 1 }] },
  ] },
} as unknown as ProductDetail;

function task(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 't1', label: '核查 松花湖 的 VBK POI 映射', type: 'vbk',
    status: 'queued', state: 'researching', detail: '已找到多个候选 POI', ...overrides,
  };
}

test('POI 待处理行带删除目标：research task 与地域阻塞都指向可移除的景点', () => {
  const taskRow = buildOpenIssueRows({
    ready: false, completion: 80,
    issues: [{ label: '核查 松花湖 的 VBK POI 映射', detail: '已找到多个候选 POI' }],
  }, [task()], product)[0]!;
  assert.deepEqual(taskRow.poiDeleteTarget, { taskId: 't1' });
  assert.equal(taskRow.poiName, '松花湖');
  assert.equal(taskRow.taskId, 't1');

  const regionRow = buildOpenIssueRows({
    ready: false, completion: 80,
    issues: [{ label: '第2天景点地域：松花湖', detail: '已保存 POI 的地域缺少证据' }],
  }, [], product)[0]!;
  assert.deepEqual(regionRow.poiDeleteTarget, { dayIndex: 1, spotIndex: 0 });
  assert.equal(regionRow.poiName, '松花湖');
  assert.equal(regionRow.taskId, undefined);
});

test('非 POI 的待处理事项不提供删除 POI 入口', () => {
  const hotel = task({ id: 't2', label: '核查 松花湖 的酒店档次', type: 'vbk' });
  const rows = buildOpenIssueRows({
    ready: false, completion: 80,
    issues: [{ label: '酒店档次', detail: '需确认酒店档次' }],
  }, [hotel], product);
  assert.equal(rows[0]!.poiDeleteTarget, undefined);
});
