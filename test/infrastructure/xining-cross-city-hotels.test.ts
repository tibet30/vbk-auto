import test from 'node:test';
import assert from 'node:assert/strict';
import { hotelLocationFromHotelText } from '../../src/shared/region-overrides.js';
import { hotelSearchContextCityForDay, hotelSearchAnchorNames } from '../../src/main/infrastructure/ctrip-hotel-search.js';
import { hotelStayRequirement } from '../../src/shared/hotel-stay-requirement.js';

test('short-name overnight placeholders retain the nightly city instead of the Xining meeting anchor', () => {
  for (const city of ['大柴旦', '冷湖', '瓜州']) {
    const day = { hotel: `${city}当地5钻酒店`, spots: [{ name: '当日景点', kind: 'attraction', city: '海西' }] };
    assert.equal(hotelLocationFromHotelText(day.hotel), city);
    assert.equal(hotelSearchContextCityForDay(day, '西宁'), city);
    assert.equal(hotelSearchAnchorNames(day, '西宁')[0], city);
  }
});

test('a verified overnight city is not overwritten by a POI broad administrative parent', () => {
  const day = { day: 4, hotel: '冷湖当地酒店', hotelRequirement: { anchorName: '冷湖镇', cityName: '茫崖', maxDistanceKm: 5 },
    spots: [{ name: '冷湖', poiName: '冷湖', poiId: 22881469, city: '海西', district: '海西' }] };
  assert.equal(hotelStayRequirement({ basicInfo: { userIdea: 'D4：俄博梁 - 冷湖' } }, day)?.cityName, '茫崖');
});

test('generic overnight lodging uses the verified final POI city while an explicit return to Xining wins', () => {
  const day = { hotel: '当地5钻酒店', spots: [{ name: '当日景点', kind: 'attraction', city: '海西' }] };
  assert.equal(hotelSearchContextCityForDay(day, '西宁'), '海西');
  assert.equal(hotelSearchContextCityForDay({ ...day, hotel: '西宁当地5钻酒店' }, '西宁'), '西宁');
  assert.equal(hotelLocationFromHotelText('大柴旦翡翠湖旅游景区'), '');
  assert.equal(hotelLocationFromHotelText('留侯镇当地民宿'), '');
});
