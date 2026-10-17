import { ReplayDataMissingError } from "../../src/main/infrastructure/replay-data-error.js";
import type { ResourceQueryOverrides } from '../../src/main/planning/resource-query-overrides.js';
import type { VbkBrowser } from '../../src/main/infrastructure/vbk-browser.js';
import { EMPTY_VBK_SESSION_CONTEXT } from '../../src/main/infrastructure/vbk-session-request.js';
import { type RegressionFixture, type Json } from './corpus.js';
import { hotelTransport, loadProviderReplay, type ProviderReplay } from './provider-replay.js';
import { PRODUCT_FORM_PATTERN_IDS } from '../../src/shared/recommendation-category-policy.js';

/** Semantic query projections; never selects, binds or returns a completed product. */
export function createQueryReplay(fixture: RegressionFixture, provider: ProviderReplay = loadProviderReplay(fixture.key)) {
  const calls: string[] = [];
  const misses: string[] = [];
  const missing = (query: string): never => { misses.push(query); throw new ReplayDataMissingError(`缺少资源查询回放：${query}`); };
  const queries: ResourceQueryOverrides = {
    recommendationCategoryPolicy: async productForm => {
      calls.push(`recommendation-category-policy:${productForm}`);
      const limited = productForm !== 'freeTravel';
      const categoryIds = limited ? [1, 2, 3, 5, 15] : [1, 2, 3, 5, 9, 15];
      const categories = limited
        ? ['服务保障', '贴心赠送', '精选酒店', '特色美食', '缤纷体验']
        : ['服务保障', '贴心赠送', '精选酒店', '特色美食', '优选行程', '缤纷体验'];
      return {
        source: 'fixed-replay', inputLocale: 'zh-CN', productPatternId: PRODUCT_FORM_PATTERN_IDS[productForm],
        limited, categoryIds, categories,
        fetchedAt: '2026-10-16T00:00:00.000Z',
      };
    },
    poiAvailability: async id => {
      calls.push(`availability:${id}`);
      const item = fixture.poiReplay.find(p => p.candidate.poiId === id);
      if (!item?.availability.status) return missing(`availability:${id}`);
      return structuredClone(item.availability) as { status: 'available' | 'suspended' };
    },
    hotelFetch: hotelTransport(provider, calls, missing),
    coverGenerationFetch: async () => missing("cover:image_generation"),
    coverSearch: async (_page, keyword) => {
      calls.push(`cover:${keyword}`);
      const recording = provider.covers.find(row => row.keyword === keyword);
      if (!Array.isArray(recording?.result?.candidates) || !recording.provenance) return missing(`cover:${keyword}`);
      return structuredClone(recording.result) as any;
    },
  };
  const page = {
    nativeOnly: true,
    evaluate: async () => missing('browser.evaluate'),
    vbkSessionFetch: async (request: Json) => {
      const endpoint = new URL(request.endpoint).pathname;
      calls.push(`native:${endpoint}`);
      if (endpoint.endsWith('/suggestDistrict')) {
        const keyword = request.body.keyword;
        const recording = provider.districts.find(row => row.keyword === keyword);
        if (!recording?.payload?.ResponseStatus || !recording.provenance
          || recording.payload.ResponseStatus.Ack === 'Success' && !Array.isArray(recording.payload.districts)) return missing(`district:${keyword}`);
        return { status: 200, payload: structuredClone(recording.payload),
          durationMs: 0, ctx: { ...EMPTY_VBK_SESSION_CONTEXT } };
      }
      const listFields: Record<string, string> = { suggestPoi: 'poiList', suggestAirport: 'airports',
        suggestTrainStation: 'trainStations', searchResourceGroup: 'resourceGroups' };
      const field = listFields[endpoint.split('/').at(-1)!];
      if (!field) return missing(endpoint);
      const recording = provider.native.find(row => row.endpoint === endpoint
        && Object.entries(row.request).every(([key, value]) => request.body[key] === value));
      if (!recording?.provenance || !recording.payload?.ResponseStatus || !Array.isArray(recording.payload[field])) return missing(`${endpoint}:${JSON.stringify(request.body)}`);
      if (endpoint.endsWith('/suggestPoi')) calls.push(`poi:${request.body.keyword}`);
      return { status: 200, payload: structuredClone(recording.payload),
        durationMs: 0, ctx: { ...EMPTY_VBK_SESSION_CONTEXT } };
    },
  };
  const browser = { requestPage: async () => page, page: async () => page,
    status: async () => ({ loggedIn: true, loginAccount: 'isolated-regression' }) } as unknown as VbkBrowser;
  return { queries, browser, calls, misses };
}
