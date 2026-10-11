import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProductDetail } from '../../src/shared/contracts.js';

export type Json = Record<string, any>;
export const CASE_KEYS = ['xian', 'chaoshan', 'luzhou', 'chengdu', 'rikaze'] as const;
export const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/product-regression/', import.meta.url));
export interface RegressionFixture {
  version: number; key: string; sourceId: string; name: string; tags: string[];
  recordedAt: string; createdAt: string; provenance: string;
  product: Json; resourceEvidence: Json;
  messages: ProductDetail['messages']; researchTasks: ProductDetail['researchTasks'];
  poiReplay: Array<{ day: number; keyword: string; candidate: Json; availability: Json }>;
  manualAsset: { file: string; sha256: string } | null;
  modelReplay: { content: string };
}
export function loadCase(key: string): RegressionFixture {
  if (!(CASE_KEYS as readonly string[]).includes(key)) throw new Error(`未知回归 case：${key}`);
  const fixture = JSON.parse(readFileSync(`${FIXTURE_ROOT}/${key}.json`, 'utf8')) as RegressionFixture;
  if (fixture.version !== 1 || fixture.key !== key || !fixture.poiReplay.length) throw new Error(`回放资料不完整：${key}`);
  return fixture;
}
export function productDetail(fixture: RegressionFixture): ProductDetail & { product: Json } {
  return {
    id: `regression-${fixture.key}`, name: fixture.name, status: 'planning',
    product: structuredClone(fixture.product),
    messages: structuredClone(fixture.messages), researchTasks: structuredClone(fixture.researchTasks),
    createdAt: fixture.createdAt, updatedAt: fixture.recordedAt,
  } as ProductDetail & { product: Json };
}
/** Semantic query boundary: persisted candidate projections, never fabricated raw HTTP. */
export function replayPoi(fixture: RegressionFixture, day: number, keyword: string) {
  const recorded = fixture.poiReplay.find(item => item.day === day && item.keyword === keyword);
  if (!recorded?.availability?.status) throw new Error(`缺少 POI 回放：${fixture.key}/${day}/${keyword}`);
  const c = { ...recorded.candidate };
  if (!c.province || !c.city) {
    const evidence = JSON.parse(readFileSync(`${FIXTURE_ROOT}/poi-location-evidence.json`, 'utf8')) as Json[];
    const source = evidence.find(item => item.poiId === c.poiId && item.poiName === c.poiName);
    if (!source || source.result !== 0 || !source.address || !source.recordedAt
      || source.endpoint !== 'https://m.ctrip.com/restapi/soa2/18109/json/getSightOnlinePage'
      || !source.location?.province || !source.location?.city
      || !source.address.includes(`${source.location.city}市`)) {
      throw new Error(`缺少可信 POI 位置回放：${fixture.key}/${day}/${keyword}`);
    }
    Object.assign(c, source.location);
  }
  return {
    detail: { httpStatus: 200, businessStatus: 'Success', poiListCount: 1,
      best: { poiId: c.poiId, poiName: c.poiName },
      candidates: [{ index: 0, poiId: c.poiId, poiName: c.poiName,
        province: c.province, city: c.city, district: c.district, selectable: true, textFields: [] }] },
    availability: structuredClone(recorded.availability),
  };
}
export function routeSignature(product: Json) {
  return product.itinerary.map((day: Json) => ({ day: day.day,
    spots: day.spots.map((s: Json) => ({ name: s.name, kind: s.kind ?? 'attraction', relation: s.relation, timeOfDay: s.timeOfDay })) }));
}
