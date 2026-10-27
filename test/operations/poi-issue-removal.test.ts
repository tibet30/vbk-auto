import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnverifiedPoiSpot, removePoiIssueSpots } from '../../src/main/operations/poi-issue-removal.js';
import { hasNoPoiIssue } from './poi-issue-removal.helpers.js';

function product() {
  return {
    itinerary: [
      { day: 1, spots: [{ name: '自由活动', kind: 'free' }] },
      { day: 2, spots: [
        { name: '松花湖', kind: 'attraction' },
        { name: '雪韵大街', kind: 'attraction' },
        { name: '棒槌山夜景', kind: 'attraction' },
        { name: '雪地蹦迪', kind: 'other' },
      ] },
      { day: 3, spots: [{ name: '长白山北景区', kind: 'attraction' }] },
    ],
  };
}

test('按 task 删除同名 POI，保留同一天其它景点并写入删除凭证', () => {
  const result = removePoiIssueSpots(product(), { label: '核查 松花湖 的 VBK POI 映射', type: 'vbk' }, {});
  assert.deepEqual(result.removed.map((item) => item.name), ['松花湖']);
  assert.equal((result.product.itinerary as any[])[1].spots.length, 3);
  const receipt = (result.product.manualReview as any)?.itinerarySpotRemovals?.[0];
  assert.equal(receipt?.name, '松花湖');
});

test('复合任务名按 & 拆分后删除全部组件，待处理项不能只处理一半', () => {
  const result = removePoiIssueSpots(product(), { label: '核查 雪韵大街&棒槌山夜景 的 VBK POI 映射', type: 'vbk' }, {});
  assert.deepEqual(result.removed.map((item) => item.name), ['雪韵大街', '棒槌山夜景']);
  assert.equal((result.product.itinerary as any[])[1].spots.length, 2);
  assert.equal(hasUnverifiedPoiSpot(result.product, result.names), false);
});

test('删除后仍有未核验同名景点时拒绝结案', () => {
  const current = product();
  const result = removePoiIssueSpots(current, { label: '核查 松花湖 的 VBK POI 映射', type: 'vbk' }, {});
  (result.product.itinerary as any[])[2].spots.push({ name: '松花湖', kind: 'attraction' });
  assert.equal(hasUnverifiedPoiSpot(result.product, result.names), true);
});

test('已不在行程中的历史 task 删除时不需要改行程', () => {
  const result = removePoiIssueSpots(product(), { label: '核查 入 \n【 的 VBK POI 映射', type: 'vbk' }, {});
  assert.deepEqual(result.removed, []);
  assert.equal(hasUnverifiedPoiSpot(result.product, result.names), false);
});

test('具体 day/spot 删除用于地域阻塞行', () => {
  const result = removePoiIssueSpots(product(), undefined, { dayIndex: 1, spotIndex: 0 });
  assert.deepEqual(result.removed, [{ dayIndex: 1, spotIndex: 0, name: '松花湖' }]);
  assert.equal(hasNoPoiIssue(result.product), true);
});

test('删除 POI 后通过生产原子写入结清 research task，独立回读保留凭证', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { VbkDatabase } = await import('../../src/main/infrastructure/database/database.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-poi-delete-'));
  const db = new VbkDatabase(dir);
  let reader: InstanceType<typeof VbkDatabase> | undefined;
  try {
    const created = db.createProduct({ destination: '吉林', days: 2, productForm: 'privateTour' });
    db.updateProduct(created.id, { ...created.product, itinerary: product().itinerary });
    const taskId = db.addResearchTask(created.id, { label: '核查 松花湖 的 VBK POI 映射', type: 'vbk', detail: '已找到多个候选 POI' });
    const current = db.getProduct(created.id)!;
    const removal = removePoiIssueSpots(current.product, { label: '核查 松花湖 的 VBK POI 映射', type: 'vbk' }, {});
    const saved = db.replaceProductAndSatisfyResearchTasks(created.id, removal.product, {
      researchEvidenceTitle: '[itinerary-operator:removed] 运营已删除 POI 待处理项并移除对应行程景点',
    });
    reader = new VbkDatabase(dir);
    const reloaded = reader.getProduct(created.id)!;
    const task = reloaded.researchTasks.find((item) => item.id === taskId)!;
    assert.equal(task.state, 'confirmed');
    assert.match(task.evidence?.[0]?.title ?? '', /运营已手动删除/);
    assert.ok(!(reloaded.product.itinerary as any[])[1].spots.some((spot: any) => spot.name === '松花湖'));
    assert.deepEqual(saved.confirmedTaskIds, [taskId]);
  } finally {
    reader?.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
