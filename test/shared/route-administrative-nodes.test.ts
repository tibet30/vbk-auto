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
