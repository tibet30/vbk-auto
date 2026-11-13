import { CASE_KEYS, loadCase, productDetail, type Json } from './corpus.js';
import { readOnlyFetcher, readOnlySession, classifyQueryError } from './read-only-client.js';
import { suggestPoiDetail } from '../../src/main/infrastructure/poi-suggest.js';
import { getCtripSightAvailability } from '../../src/main/infrastructure/ctrip-sight-availability.js';
import { resolvePlanningPoiAutoSelection } from '../../src/main/planning/poi-auto-selection.js';
import { productNeedsVehicleResource } from '../../src/shared/product-form.js';
import { matchVehicleResource } from '../../src/main/operations/vehicle-resource/matching.js';
import { buildVehicleResourceQuery, targetVehicleTotalCost } from '../../src/main/operations/vehicle-resource/query.js';
import { searchVehicleResourceGroups } from '../../src/main/operations/vehicle-resource/search.js';
import { preflightTrafficLineEndpoints } from '../../src/main/automation/ctrip/traffic-line/endpoints.js';
import { requiresItineraryPoi } from '../../src/shared/itinerary-activity-kind.js';
import type { Page } from 'playwright';

// Live reads are an explicit separate command. Missing authentication never falls back to replay.
const ticket = process.env.VBK_TICKET?.trim();
if (!ticket) {
  console.error('[product-online] blocked：缺少临时 VBK_TICKET；未联网，未修改样本或业务数据。');
  process.exit(2);
}
const originalFetch = globalThis.fetch;
const fetcher = readOnlyFetcher(originalFetch, ticket);
const session = readOnlySession(fetcher);
const counts = { unchanged: 0, changed: 0, blocked: 0, failed: 0 };
globalThis.fetch = fetcher;
try {
  for (const key of CASE_KEYS) {
    const fixture = loadCase(key);
    const detail = productDetail(fixture);
    const p = detail.product as Json;
    async function check(resource: string, query: () => Promise<boolean>) {
      let status: keyof typeof counts;
      try { status = await query() ? 'unchanged' : 'changed'; }
      catch (error) { status = classifyQueryError(error); }
      counts[status]++;
      console.log(JSON.stringify({ case: key, resource, status, remoteWrites: 0 }));
    }
    for (const day of p.itinerary as Json[]) for (const spot of day.spots as Json[]) {
      if (!requiresItineraryPoi(spot)) continue;
      await check(`POI:${day.day}:${spot.name}`, async () => {
        const result = await resolvePlanningPoiAutoSelection({ localProductId: detail.id,
          keyword: spot.name, product: p,
          context: { destinationCity: p.basicInfo.meetingCity, province: p.basicInfo.province },
          detail: await suggestPoiDetail(session, spot.name, { destinationCity: p.basicInfo.meetingCity, province: p.basicInfo.province }),
          confirmedPoiId: spot.poiId,
          checkAvailability: id => getCtripSightAvailability(undefined, id),
        });
        return result.status === 'available' && result.match?.poiId === spot.poiId;
      });
    }
    // 住宿统一由平台自动匹配三/四/五钻，本地不再查询或绑定具体酒店候选，
    // 因此在线核验只覆盖 POI、用车资源组与大交通端点。
    if (productNeedsVehicleResource(p)) await check('用车资源', async () => {
      const estimate = buildVehicleResourceQuery({ city: p.operations.pickupCity || p.basicInfo.meetingCity,
        days: p.basicInfo.days, serviceHoursPerDay: p.operations.vehicleResource?.serviceHoursPerDay });
      const result = await matchVehicleResource(estimate, targetVehicleTotalCost(p),
        query => searchVehicleResourceGroups(session as unknown as Page, query));
      return result.selected?.resourceGroupId === p.operations.vehicleResource?.resourceGroupId;
    });
    if (p.operations.trafficLine?.enabled) await check('大交通端点', async () => {
      const result = await preflightTrafficLineEndpoints(session, p.itinerary, new Date(),
        undefined, p, p.operations.trafficLine.variants);
      const saved = p.operations.trafficLine.availability;
      const signature = (v: Json) => JSON.stringify([v.availableVariants, v.endpointPlan.arrivalCity,
        v.endpointPlan.departureCity, v.endpointPlan.flight, v.endpointPlan.train]);
      return signature(result) === signature(saved);
    });
  }
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ summary: counts, fixtureUpdates: 0, businessWrites: 0, remoteWrites: 0 }));
process.exitCode = counts.failed || counts.changed ? 1 : counts.blocked ? 2 : 0;
