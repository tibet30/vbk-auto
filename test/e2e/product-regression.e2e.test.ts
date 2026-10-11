// @test-layer e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { evaluatePreparationCompletion } from '../../src/main/planning/preparation-completion.js';
import { denyPreparationTool } from '../../src/main/agent/preparation-action-guard.js';
import { CASE_KEYS, loadCase, routeSignature, type Json } from '../../scripts/product-regression/corpus.js';
import { runFullPreparation } from '../../scripts/product-regression/full-flow.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';
import { gateResults } from '../../scripts/product-regression/report.js';
import { assertBaseline } from './product-regression/baselines.js';
import { assertRepresentativeFeatures } from './product-regression/assertions.js';

for (const key of CASE_KEYS) {
  test(`产品完整 E2E ${key}：原始需求 → 生成 → 筛查 → 保存回读 → 方案确认`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-11T04:00:00Z') });
    const network = forbidNetwork();
    context.after(() => { network.restore(); assert.deepEqual(network.attempts, [], '不得尝试真实联网'); });
    const root = mkdtempSync(path.join(os.tmpdir(), 'vbk-product-regression-'));
    const db = new VbkDatabase(root);
    context.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    // Production createProduct constructs its own empty draft; importing completed snapshots is forbidden.
    db.importProductSnapshot = () => { throw new Error('完整 E2E 禁止直接导入已完成方案'); };
    const fixture = loadCase(key);
    const result = await runFullPreparation(db, fixture, root);
    const saved = result.saved;
    const p = saved.product as Json;
    if (result.snapshot.run?.status !== 'waiting_approval') console.log(JSON.stringify({ case: key,
      status: result.snapshot.run?.status, missing: evaluatePreparationCompletion(saved).missing,
      events: result.snapshot.events.filter(e => ['tool_result', 'status'].includes(e.type)).map(e => e.content.slice(0, 250)) }));
    assert.ok(result.checkpoints.some(c => c.days === fixture.product.basicInfo.days && c.boundPois === 0 && c.hotelDays === 0),
      '必须先保存未绑定资源的生成行程，再筛查绑定资源');
    assert.ok(result.checkpoints.some(c => c.boundPois > 0 && c.hotelDays === fixture.product.basicInfo.nights));
    const reader = new VbkDatabase(root);
    try {
      assert.deepEqual(reader.getProduct(saved.id)?.product, p, '独立数据库连接必须读到最终方案');
      assert.deepEqual(reader.getAgentSnapshot(saved.id), result.snapshot, '方案确认和审批请求必须持久化');
    } finally { reader.close(); }
    assert.deepEqual(result.modelMisses, [], '缺少模型回放必须失败，不能被 SDK 包装或生产重试掩盖');
    assert.deepEqual(result.misses, [], '缺少查询回放必须失败，不能被生产重试吞掉');
    assert.deepEqual(result.blockedWrites, [], '任何外部写入或交接尝试都算失败');
    assert.equal(result.snapshot.events.some(e => e.content.startsWith('工具失败：')), false,
      '完整回放中生产工具不得失败或依靠重试掩盖失败');
    assert.deepEqual([...new Set(result.stages)].sort(), ['basicInfo', 'commercial', 'itinerary', 'presentation', 'skeleton']);
    assert.deepEqual(routeSignature(p), routeSignature(fixture.product), '路线顺序、二选一、活动类型必须保留');
    assertRepresentativeFeatures(key, p);
    assert.ok(result.queries.filter(q => q.startsWith('hotel-context:')).length >= fixture.product.basicInfo.nights);
    assert.ok(result.queries.filter(q => q.startsWith('hotel-list:')).length >= fixture.product.basicInfo.nights,
      '每晚必须查询地标及原始列表，经生产解析、过滤、排序后保存');
    if (key === 'rikaze') assert.equal(result.queries.some(q => q.endsWith('/suggestAirport')), false,
      '仅火车套餐不得扩展机场查询');
    if (key === 'luzhou') assert.equal(result.queries.some(q => /suggestAirport|suggestTrainStation|searchResourceGroup/u.test(q)), false);
    if (key === 'chengdu') assert.equal(result.queries.some(q => q.endsWith('/searchResourceGroup')), false);
    assert.equal(saved.productId, undefined);
    assert.equal(saved.automation, undefined);
    assert.equal(p.basicInfo.meetingCity, result.initial.product.basicInfo && (result.initial.product.basicInfo as Json).meetingCity);
    assert.equal(p.basicInfo.destinationCity, p.basicInfo.meetingCity);
    const evaluation = evaluatePreparationCompletion(saved);
    assertBaseline(fixture, evaluation, []);
    assert.equal(result.snapshot.run?.status, 'waiting_approval', JSON.stringify(result.snapshot.events.slice(-8)));
    assert.ok(result.snapshot.pendingApproval, '必须生成本次新的审批请求');
    assert.equal(result.snapshot.events.some(e => e.data?.remoteWrite === true), false);
    assert.equal(denyPreparationTool(saved, undefined, 'request_approval'), undefined);
    const incomplete = structuredClone(saved);
    const first = (incomplete.product.itinerary as Json[]).flatMap(day => day.spots)
      .find((spot: Json) => (spot.kind ?? 'attraction') === 'attraction');
    first.poiId = null; first.poiName = null;
    assert.throws(() => assertBaseline(fixture, evaluatePreparationCompletion(incomplete), []), /门禁不得阻塞/);
    assert.ok(denyPreparationTool(incomplete, undefined, 'request_approval'));
    console.log(JSON.stringify({ case: key, start: 'original_requirements', stages: result.stages,
      queryCount: result.queries.length, operatorActions: result.operators, gates: gateResults(p, evaluation),
      actualTools: result.snapshot.events.filter(e => e.type === 'tool_call').map(e => ({ name: e.data?.name, arguments: e.data?.arguments })),
      queryTrace: result.queries, persistedReadbacks: result.checkpoints.length,
      hotels: p.itinerary.filter((d: Json) => d.hotelCandidates?.length).map((d: Json) => ({ day: d.day, candidateCount: d.hotelCandidates.length })),
      status: result.snapshot.run?.status, newApproval: Boolean(result.snapshot.pendingApproval),
      verdict: 'ready', ready: true, remoteWrites: result.blockedWrites.length, networkAttempts: network.attempts.length }));
  });
}
