import test from 'node:test';
import assert from 'node:assert/strict';
import { createHotelCandidateResolver } from '../../src/main/infrastructure/ctrip-hotel-search/resolve.js';
import { loadCase } from '../../scripts/product-regression/corpus.js';
import { loadProviderReplay } from '../../scripts/product-regression/provider-replay.js';
import { createQueryReplay } from '../../scripts/product-regression/query-replay.js';
import { loadGenerationReplay } from '../../scripts/product-regression/generation-replay.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';

function inputs() {
  const provider = loadProviderReplay('xian');
  const requirement = loadGenerationReplay('xian').hotelRequirements[0].requirement;
  return { provider, requirement, fixture: loadCase('xian') };
}
test('酒店固定 HTTP 回复仍经过生产地标选择、城市/评级过滤、距离计算和排序', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-11T04:00:00Z') });
  const isolation = forbidNetwork();
  context.after(() => { isolation.restore(); assert.deepEqual(isolation.attempts, []); });
  const { provider, requirement, fixture } = inputs();
  const rows = provider.lists[0].rows as any[];
  // A provider response containing a foreign-city card cannot pass because its name looks right.
  const foreign = structuredClone(rows[0]);
  foreign.hotelInfo.positionInfo.cityId = -1;
  foreign.hotelInfo.summary.hotelId = 999999999;
  provider.lists[0].rows = [foreign, ...rows.slice().reverse()];
  const replay = createQueryReplay(fixture, provider);
  const resolve = createHotelCandidateResolver(replay.queries.hotelFetch);
  const result = await resolve([{ day: 1, hotel: requirement.anchorName }], requirement.cityName, 1,
    '当地5钻酒店', undefined, new Map([[1, requirement as any]]));
  const candidates = result.dailyCandidates[0].candidates;
  assert.equal(candidates.some(c => c.hotelId === 999999999), false);
  assert.ok(candidates.every(c => c.diamond === 5 && c.distanceKm <= 5 && c.ratingType === 'diamond'));
  assert.deepEqual(candidates.map(c => c.distanceKm), candidates.map(c => c.distanceKm).sort((a, b) => a - b));
  assert.equal(replay.calls.filter(q => q.startsWith('hotel-context:')).length, 1);
  assert.equal(replay.calls.filter(q => q.startsWith('hotel-list:')).length, 1);
});

test('生产降档流程遇到缺少下一档的回放必须失败，不补成空结果或成功', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-11T04:00:00Z') });
  const { provider, requirement, fixture } = inputs();
  provider.lists[0].rows = []; // An explicit empty reply triggers the production downgrade policy.
  const replay = createQueryReplay(fixture, provider);
  const resolve = createHotelCandidateResolver(replay.queries.hotelFetch);
  await assert.rejects(resolve([{ day: 1, hotel: requirement.anchorName }], requirement.cityName, 1,
    '当地5钻酒店', undefined, new Map([[1, requirement as any]]), true), /缺少资源查询回放/);
  assert.equal(replay.calls.filter(q => q.startsWith('hotel-list:')).length, 2);
  assert.equal(replay.misses.length, 1);
  assert.match(replay.misses[0], /16%7E4/);
});
