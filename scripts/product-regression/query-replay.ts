import { ReplayDataMissingError } from "../../src/main/infrastructure/replay-data-error.js";
import type { ResourceQueryOverrides } from '../../src/main/planning/resource-query-overrides.js';
import type { VbkBrowser } from '../../src/main/infrastructure/vbk-browser.js';
import { EMPTY_VBK_SESSION_CONTEXT } from '../../src/main/infrastructure/vbk-session-request.js';
import { type RegressionFixture, type Json } from './corpus.js';
import { hotelTransport, loadProviderReplay, type ProviderReplay } from './provider-replay.js';

/** Semantic query projections; never selects, binds or returns a completed product. */
export function createQueryReplay(fixture: RegressionFixture, provider: ProviderReplay = loadProviderReplay(fixture.key)) {
  const calls: string[] = [];
  const misses: string[] = [];
  const missing = (query: string): never => { misses.push(query); throw new ReplayDataMissingError(`缺少资源查询回放：${query}`); };
  const queries: ResourceQueryOverrides = {
    poiAvailability: async id => {
      calls.push(`availability:${id}`);
      const item = fixture.poiReplay.find(p => p.candidate.poiId === id);
      if (!item?.availability.status) return missing(`availability:${id}`);
      return structuredClone(item.availability) as { status: 'available' | 'suspended' };
    },
    hotelFetch: hotelTransport(provider, calls, missing),
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
