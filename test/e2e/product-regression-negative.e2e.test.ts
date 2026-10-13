// @test-layer e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { evaluatePreparationCompletion, preparationApprovalBlockReason } from '../../src/main/planning/preparation-completion.js';
import { CASE_KEYS, loadCase, type Json } from '../../scripts/product-regression/corpus.js';
import { loadProviderReplay } from '../../scripts/product-regression/provider-replay.js';
import { loadGenerationReplay } from '../../scripts/product-regression/generation-replay.js';
import { runFullPreparation, type RegressionFaults } from '../../scripts/product-regression/full-flow.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';
import { gateResults } from '../../scripts/product-regression/report.js';

const faults = ['missing_model', 'missing_resource', 'wrong_poi_match', 'corrupted_saved_match'] as const;
for (const key of CASE_KEYS) for (const fault of faults) {
  test(`产品负向 E2E ${key}/${fault}：生产流程禁止录入审批`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-11T04:00:00Z') });
    const network = forbidNetwork();
    const root = mkdtempSync(path.join(os.tmpdir(), 'vbk-negative-e2e-'));
    const db = new VbkDatabase(root);
    context.after(() => { db.close(); rmSync(root, { recursive: true, force: true });
      network.restore(); assert.deepEqual(network.attempts, []); });
    const fixture = loadCase(key);
    const provider = loadProviderReplay(key);
    const model = loadGenerationReplay(key);
    const options: RegressionFaults = { model };
    if (fault === 'missing_model') delete model.stageResponses.commercial;
    if (fault === 'missing_resource') options.corruptSaved = product => {
      if (product.operations?.hotelMatchingMode !== 'rules') return;
      delete product.operations.hotelRules;
      return product;
    };
    if (fault === 'wrong_poi_match') {
      const rows = provider.native.filter(row => row.endpoint.endsWith('/suggestPoi'));
      for (const row of rows) {
        const cities = [fixture.product.basicInfo.meetingCity,
          ...row.payload.poiList.flatMap((poi: Json) => poi.district.parents
            .filter((parent: Json) => parent.districtType === 'City').map((parent: Json) => parent.districtName))];
        for (const city of cities) {
          const alias = row.request.keyword.startsWith(city) ? row.request.keyword.slice(city.length) : '';
          if (alias && !provider.native.some(other => other.endpoint === row.endpoint && other.request.keyword === alias)) {
            provider.native.push({ ...structuredClone(row), request: { keyword: alias } });
          }
        }
      }
      for (const row of provider.native.filter(row => row.endpoint.endsWith('/suggestPoi'))) {
        for (const poi of row.payload.poiList) poi.district.parents = [
          { districtType: 'City', districtName: '哈尔滨' }, { districtType: 'Province', districtName: '黑龙江' }];
      }
    }
    if (fault === 'corrupted_saved_match') options.corruptSaved = product => {
      const days = product.itinerary as Json[];
      if (!days.some(day => day.hotelCity)) return;
      const spot = days.flatMap(day => day.spots ?? []).find(spot => spot.poiId);
      if (!spot) return;
      spot.poiId = null; spot.poiName = null;
      return product;
    };
    const result = await runFullPreparation(db, fixture, root, provider, options);
    if (fault === 'missing_model') assert.ok(result.modelMisses.includes('stage:submit_commercial_module'));
    if (fault === 'missing_resource') { assert.ok(result.corruptions > 0); assert.equal(result.saved.product.operations?.hotelRules, undefined); }
    if (fault === 'wrong_poi_match') {
      assert.ok(result.queries.some(query => query.startsWith('poi:')));
      assert.deepEqual(result.misses, [], '地域破坏不能靠缺少查询回放造成失败');
      assert.deepEqual(result.modelMisses, [], '地域破坏不能靠缺少模型回放造成失败');
    }
    if (fault === 'corrupted_saved_match') assert.ok(result.corruptions > 0, '必须实际破坏已保存的绑定结果');
    const evaluation = evaluatePreparationCompletion(result.saved, result.snapshot);
    assert.equal(evaluation.ready, false, '生产门禁必须发现缺项');
    assert.ok(preparationApprovalBlockReason(result.saved));
    assert.notEqual(result.snapshot.run?.status, 'waiting_approval');
    assert.equal(Boolean(result.snapshot.pendingApproval), false);
    assert.equal(result.snapshot.events.some(event => event.type === 'approval'), false);
    assert.equal(result.saved.productId, undefined);
    assert.equal(result.saved.automation, undefined);
    assert.deepEqual(result.blockedWrites, []);
    const reader = new VbkDatabase(root);
    try {
      assert.deepEqual(reader.getProduct(result.saved.id)?.product, result.saved.product);
      assert.equal(Boolean(reader.getAgentSnapshot(result.saved.id)?.pendingApproval), false);
    } finally { reader.close(); }
    console.log(JSON.stringify({ case: key, fault, status: result.snapshot.run?.status,
      stages: result.stages, gates: gateResults(result.saved.product, evaluation), missing: evaluation.missing,
      modelMisses: result.modelMisses, resourceMisses: result.misses, corruptions: result.corruptions,
      approval: false, remoteWrites: result.blockedWrites.length, networkAttempts: network.attempts.length }));
  });
}
