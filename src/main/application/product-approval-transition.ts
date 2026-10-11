import type { AgentApproval, AgentSnapshot } from '../../shared/contracts-agent.js';
import { approvedPlanVersion } from './product-approval-projection.js';
import { canonicalJson, record } from '../../shared/product-storage-projection.js';
import { toPlatformShortLocationName } from '../../shared/location-short-name.js';

function selections(product: Record<string, unknown>) {
  const basic = record(product.basicInfo); const ops = record(product.operations);
  return {
    commercial: product.commercial,
    days: basic.days, nights: basic.nights,
    meetingCity: toPlatformShortLocationName(basic.meetingCity),
    destinationCity: toPlatformShortLocationName(basic.destinationCity),
    hotelTier: ops.hotelTier, hotelSource: ops.hotelSource, vehicle: ops.vehicleResource,
    itinerary: (Array.isArray(product.itinerary) ? product.itinerary : []).map(value => {
      const day = record(value);
      return { day: day.day, hotelRequirement: day.hotelRequirement, hotelCandidates: day.hotelCandidates,
        spots: (Array.isArray(day.spots) ? day.spots : []).map(value => {
          const spot = record(value); return { name: spot.name, kind: spot.kind, poiId: spot.poiId, poiName: spot.poiName };
        }) };
    }),
  };
}

/** Only a transaction from the matching approved baseline may advance authority. */
export function advanceAutomationApproval(snapshot: AgentSnapshot, before: Record<string, unknown>,
  after: Record<string, unknown>): boolean {
  if (!snapshot.run || snapshot.run.status !== 'running' || snapshot.uncertainWrite) return false;
  if (canonicalJson(selections(before)) !== canonicalJson(selections(after))) return false;
  const oldVersion = approvedPlanVersion({ product: before });
  const newVersion = approvedPlanVersion({ product: after });
  if (oldVersion === newVersion) return false;
  const approval = [...snapshot.events].reverse().filter(event => event.runId === snapshot.run!.id
    && event.type === 'approval').map(event => event.data?.approval as AgentApproval | undefined)
    .find(value => value?.status === 'approved');
  if (!approval || approval.intentVersion !== snapshot.run.intentVersion || approval.productVersion !== oldVersion) return false;
  approval.productVersion = newVersion;
  return true;
}
