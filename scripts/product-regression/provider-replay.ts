import { readFileSync } from 'node:fs';
import { FIXTURE_ROOT, type Json } from './corpus.js';
import { CTRIP_HOTEL_SUGGEST_ENDPOINT } from '../../src/main/infrastructure/ctrip-hotel-search/provider.js';

export interface ProviderReplay {
  version: number; recordedAt: string; provenance: string;
  native: Array<{ endpoint: string; request: Json; payload: Json; provenance: string }>;
  contexts: Array<{ keyword: string; rows: unknown[] }>;
  lists: Array<{ url: string; rows: unknown[] }>;
  districts: Array<{ keyword: string; payload: Json; provenance: string }>;
  covers: Array<{ keyword: string; result: Json; provenance: string }>;
}
export function loadProviderReplay(key: string): ProviderReplay {
  const data = JSON.parse(readFileSync(`${FIXTURE_ROOT}/${key}-queries.json`, 'utf8')) as ProviderReplay;
  if (data.version !== 1 || !data.recordedAt || !data.contexts || !data.lists || !data.districts || !data.covers || !Array.isArray(data.native)) {
    throw new Error(`缺少供应商查询回放：${key}`);
  }
  return data;
}

/** Only HTTP response data is replaced; all hotel decoding and matching stay in production. */
export function hotelTransport(data: ProviderReplay, calls: string[], missing: (query: string) => never): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CTRIP_HOTEL_SUGGEST_ENDPOINT) {
      const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as Json;
      calls.push(`hotel-context:${body.keyword}`);
      const recording = data.contexts.find(row => row.keyword === body.keyword);
      if (!recording || !Array.isArray(recording.rows)) return missing(`hotel-context:${body.keyword}`);
      return Response.json({ Result: true, Response: { searchResults: structuredClone(recording.rows) } });
    }
    const parsed = new URL(url);
    if (parsed.origin + parsed.pathname !== 'https://hotels.ctrip.com/hotels/list') return missing(`hotel-url:${url}`);
    calls.push(`hotel-list:${parsed.searchParams.get('cityId')}:${parsed.searchParams.get('searchWord') ?? ''}`);
    const recording = data.lists.find(row => row.url === url);
    if (!recording || !Array.isArray(recording.rows)) return missing(`hotel-list:${url}`);
    // Re-encode captured, unranked provider rows in the production SSR envelope.
    const flight = JSON.stringify({ initListData: { hotelList: recording.rows } });
    return new Response(`<script>self.__next_f.push([1,${JSON.stringify(flight)}]);</script>`);
  };
}
