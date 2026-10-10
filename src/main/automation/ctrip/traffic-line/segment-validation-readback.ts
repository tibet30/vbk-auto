import type { TrafficLineVariant, TrafficLineEndpointPlan } from "../../../../shared/contracts-traffic-line.js";
import { list, record, type JsonRecord, type TrafficLinePage } from "./client.js";
import { getSegments, verifySegmentBoundaries } from "./segments.js";
import { validatedDepartureCityReadbackIsComplete, verifyValidatedDepartureCityReadback } from "./segment-departure-cities.js";
type City = JsonRecord;

export function validatedSegmentReadbackIsComplete(
  payload: JsonRecord,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  submittedCities: City[] = [],
): boolean {
  if (Array.isArray(record(payload.draftProductSegments)?.segments)) return false;
  try {
    verifySegmentBoundaries(list(record(payload.productSegments)?.segments), variant, endpoints);
    return validatedDepartureCityReadbackIsComplete(payload, submittedCities);
  } catch {
    return false;
  }
}
export async function waitForValidatedSegmentReadback(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  submittedCities: City[],
  sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<JsonRecord> {
  let last: JsonRecord = {};
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    last = await getSegments(page, productId);
    if (validatedSegmentReadbackIsComplete(last, variant, endpoints, submittedCities)) return last;
    if (attempt < 40) await sleep(Math.min(1_500, attempt * 300));
  }
  if (Array.isArray(record(last.draftProductSegments)?.segments)) {
    throw new Error("子产品资源校验完成后仍存在未结算草稿，未激活套餐。");
  }
  const formal = list(record(last.productSegments)?.segments);
  verifySegmentBoundaries(formal, variant, endpoints);
  if (!validatedDepartureCityReadbackIsComplete(last, submittedCities)) {
    verifyValidatedDepartureCityReadback(last, submittedCities);
  }
  return last;
}
