import assert from 'node:assert/strict';
import test from 'node:test';
import { hasVerifiedRouteAdministrativeNode } from '../../src/shared/route-administrative-nodes.js';
import { poiResearchTaskSatisfaction } from '../../src/shared/research-task-satisfaction.js';

test('native district evidence satisfies obsolete county/short-name POI questions without claiming a POI', () => {
  const p = { diagnostics: { routeAdministrativeNodes: [{ day: 2, name: '天峻', districtId: 1446306 }] },
    itinerary: [{ day: 1, spots: [], activities: [{ type: 'transport', title: '抵达天峻县' }] }] };
  const task = { label: '核查 天峻县 的 VBK POI 映射', type: 'vbk' };
  assert.equal(hasVerifiedRouteAdministrativeNode(p, '天峻县'), true);
  assert.equal(hasVerifiedRouteAdministrativeNode(p, '天峻县', 1), false);
  assert.equal(poiResearchTaskSatisfaction(task, p), 'non_poi');
  assert.equal(hasVerifiedRouteAdministrativeNode(p, '天峻石林'), false);
  p.diagnostics.routeAdministrativeNodes[0]!.districtId = 0;
  assert.equal(poiResearchTaskSatisfaction(task, p), null);
});

test('restoring an unresolved attraction reopens the question despite an old district receipt', () => {
  const p = { diagnostics: { routeAdministrativeNodes: [{ day: 1, name: '天峻', districtId: 1446306 }] },
    itinerary: [{ day: 1, spots: [{ name: '天峻县', kind: 'attraction', poiId: null, poiName: null }] }] };
  assert.equal(poiResearchTaskSatisfaction({ label: '核查 天峻县 的 VBK POI 映射', type: 'vbk' }, p), null);
});

test('persisted lodging and road nodes retire stale POI questions without deletion receipts', () => {
  const p = { basicInfo: { meetingCity: '拉萨', userIdea: 'D1：拉萨—塔钦（宿塔尔钦）\nD2：塔钦—22道班—萨嘎（宿萨嘎）' },
    itinerary: [
      { day: 1, title: '拉萨—塔钦', spots: [] },
      { day: 2, title: '塔钦—22道班—萨嘎', spots: [] },
    ] };
  for (const name of ['拉萨', '塔钦', '22道班', '萨嘎']) {
    assert.equal(poiResearchTaskSatisfaction({ label: `核查 ${name} 的 VBK POI 映射`, type: 'vbk' }, p), 'non_poi');
  }
});
