import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { parsePoiSuggestPayload } from '../../../src/main/infrastructure/poi-suggest/parse.js';
import { ReplayDataMissingError } from '../../../src/main/infrastructure/replay-data-error.js';
import { DbOrchestratorRuntime } from '../../../src/main/planning/runtime.js';
import type { lhasaFixture } from './harness.js';
import type { ResourceQueryOverrides } from '../../../src/main/planning/resource-query-overrides.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

/** Only captured candidate/availability data are replaced; selection, save and task settlement stay production. */
export function liveRuntime(t: TestContext, fixture: Awaited<ReturnType<typeof lhasaFixture>>) {
  const rows = read('live-candidates.json') as Array<{ keyword: string; status: number; payload: any }>;
  const availability = new Map<number, { status: 'available' | 'suspended' }>(read('live-availability.json').map((row: any) => [row.poiId, row]));
  const misses: string[] = [];
  const queries: string[] = [];
  const missing = (key: string): never => { misses.push(key); throw new ReplayDataMissingError(key); };
  t.after(() => assert.deepEqual(misses, [], '缺回放不能被普通查询失败降级掩盖'));
  const overrides: ResourceQueryOverrides = {
      poi: async (keyword, context) => {
        queries.push(keyword);
        const row = rows.find(row => row.keyword === keyword) ?? missing(`poi:${keyword}`);
        return parsePoiSuggestPayload(keyword, structuredClone(row.payload), row.status, context);
      },
      poiAvailability: async id => availability.get(id) ?? missing(`availability:${id}`),
    };
  const runtime = new DbOrchestratorRuntime(fixture.db, fixture.browser, fixture.mutations,
    async work => work(), undefined, async () => ({ pickedText: null, confidence: 0 }), overrides);
  return { runtime, queries, overrides };
}
