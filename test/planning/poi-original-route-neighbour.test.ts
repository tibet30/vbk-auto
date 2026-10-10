import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlanningPoiCandidateInContext, resolvePlanningPoiAutoSelection } from '../../src/main/planning/poi-auto-selection.js';

const candidate = { index: 1, poiName: '乌素特水上雅丹地质公园', poiId: 46781314, province: '青海', city: '海西', district: '格尔木', selectable: true, textFields: [] };
function fixture() {
  return { basicInfo: { userIdea: 'D1：大柴旦翡翠湖 - 水上雅丹 - 俄博梁', province: '青海', destinationCity: '西宁' },
    itinerary: [{ day: 1, title: '大柴旦翡翠湖 → 水上雅丹 → 俄博梁', spots: [
      { name: '大柴旦翡翠湖', poiName: '大柴旦翡翠湖旅游景区', poiId: 48265518, province: '青海', city: '海西' },
      { name: '水上雅丹', poiName: null, poiId: null },
    ] }] };
}
const context = { province: '青海', destinationCity: '西宁' };
test('a unique official prefixed name in the verified original route city can pass and still checks availability', async () => {
  let availabilityId = 0;
  const result = await resolvePlanningPoiAutoSelection({ localProductId: 'original-route', keyword: '水上雅丹', product: fixture(), context,
    detail: { httpStatus: 200, businessStatus: 'Success', poiListCount: 2, best: null, candidates: [candidate,
      { ...candidate, index: 2, poiName: '最美青海·乌素特水上雅丹地质公园旅游拍摄', poiId: 2 }] },
    disambiguate: async () => ({ pickedText: '乌素特水上雅丹地质公园 · 青海/海西/格尔木', confidence: 1 }),
    checkAvailability: async id => { availabilityId = id; return { status: 'available' }; } });
  assert.equal(result.status, 'available'); assert.equal(availabilityId, 46781314);
});
test('missing or foreign evidence, different province, multiple principal POIs and facility suffixes still block', () => {
  for (const variant of ['unverified', 'other-day', 'not-original', 'wrong-city', 'wrong-province']) {
    const p = fixture(); const neighbour = p.itinerary[0]!.spots[0]!;
    if (variant === 'unverified') neighbour.poiId = null;
    if (variant === 'other-day') p.itinerary.push({ day: 2, title: '', spots: [p.itinerary[0]!.spots.shift()!] });
    if (variant === 'not-original') neighbour.name = '额外生成的景点';
    if (variant === 'wrong-city') neighbour.city = '西宁';
    if (variant === 'wrong-province') neighbour.province = '甘肃';
    assert.equal(isPlanningPoiCandidateInContext(candidate, context, p, '水上雅丹', [candidate]), false, variant);
  }
  assert.equal(isPlanningPoiCandidateInContext({ ...candidate, province: '甘肃' }, context, fixture(), '水上雅丹', [{ ...candidate, province: '甘肃' }]), false);
  assert.equal(isPlanningPoiCandidateInContext(candidate, context, fixture(), '水上雅丹', [candidate, { ...candidate, poiId: 2 }]), false);
  const facility = { ...candidate, poiName: '乌素特水上雅丹地质公园-望海台' };
  assert.equal(isPlanningPoiCandidateInContext(facility, context, fixture(), '水上雅丹', [facility]), false);
});
