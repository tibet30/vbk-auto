import assert from 'node:assert/strict';
import test from 'node:test';
import { isCombinedPoiPlaceName } from '../../src/shared/poi-name-identity.js';
import { isKnownPoiNameAlias } from '../../src/shared/poi-name-aliases.js';
import { samePoiName } from '../../src/shared/poi-name-key.js';

test('A&B/A＋B 是复合路线名，不能被当成单个 POI 精确命中一半', () => {
  for (const name of ['长白山北景区&天池', '横道河子百年小镇&机车库&油画村', '雪韵大街&棒槌山夜景',
    '雪域主峰秘境穿越&雪地摩托', '雪乡轻旅拍+雪地蹦迪', '甲景区和乙景区']) {
    assert.equal(isCombinedPoiPlaceName(name), true, name);
  }
  assert.equal(isCombinedPoiPlaceName('长白山北景区'), false);
  assert.equal(isCombinedPoiPlaceName('松花湖（滑雪、雪圈）'), false);
});

test('雾淞/雾凇 手写变体按同一 POI 身份处理，但不做子串猜测', () => {
  assert.equal(isKnownPoiNameAlias('雾淞漂流', '雾凇漂流'), true);
  assert.equal(isKnownPoiNameAlias('雾凇长廊', '雾淞长廊'), true);
  assert.equal(isKnownPoiNameAlias('雾凇长廊', '雾凇长廊晨景'), false);
  assert.equal(samePoiName('雾淞漂流', '雾凇漂流'), true);
  assert.equal(samePoiName('雾淞漂流', '长白山雾凇漂流风景区'), false);
});
