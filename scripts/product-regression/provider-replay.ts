import { readFileSync } from 'node:fs';
import { FIXTURE_ROOT, type Json } from './corpus.js';

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
