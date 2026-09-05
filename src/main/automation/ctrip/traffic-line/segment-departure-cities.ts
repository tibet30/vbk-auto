import { list, record, text, type JsonRecord } from "./client.js";

function productDepartureCity(payload: JsonRecord): JsonRecord | null {
  const draft = record(payload.draftProductSegments);
  const product = draft ?? record(payload.productSegments);
  return record(product?.productDepartureCity);
}

export function departureCitiesFromPayload(payload: JsonRecord): JsonRecord[] {
  return list(productDepartureCity(payload)?.departureCities);
}

export function verifyDepartureCityReadback(
  payload: JsonRecord,
  expectedCities: JsonRecord[] = [],
): number {
  const actual = departureCitiesFromPayload(payload);
  if (!actual.length) throw new Error("子产品资源回读缺少多出发城市，不能激活套餐。");

  const actualIds = new Set(actual.map((city) => text(city.cityId)).filter(Boolean));
  const missing = expectedCities
    .map((city) => text(city.cityId))
    .filter((cityId) => cityId && !actualIds.has(cityId));
  if (missing.length) {
    throw new Error(`子产品资源回读缺少已保存的出发城市：${missing.join("、")}。`);
  }
  return actual.length;
}

export function departureCityReadbackIsComplete(
  payload: JsonRecord,
  expectedCities: JsonRecord[] = [],
): boolean {
  try {
    verifyDepartureCityReadback(payload, expectedCities);
    return true;
  } catch {
    return false;
  }
}

/**
 * 班期校验会自动剔除无交通资源的城市；正式结果允许是提交集合的非空子集，
 * 但绝不能为空或混入本轮未提交的城市。
 */
export function verifyValidatedDepartureCityReadback(
  payload: JsonRecord,
  submittedCities: JsonRecord[] = [],
): number {
  const product = record(payload.productSegments);
  const actual = list(record(product?.productDepartureCity)?.departureCities);
  if (!actual.length) throw new Error("子产品资源校验后没有任何可用的多出发城市。");
  if (!submittedCities.length) return actual.length;

  const submittedIds = new Set(submittedCities.map((city) => text(city.cityId)).filter(Boolean));
  const unexpected = actual
    .map((city) => text(city.cityId))
    .filter((cityId) => cityId && !submittedIds.has(cityId));
  if (unexpected.length) {
    throw new Error(`子产品正式资源出现本轮未提交的出发城市：${[...new Set(unexpected)].join("、")}。`);
  }
  return actual.length;
}

export function validatedDepartureCityReadbackIsComplete(
  payload: JsonRecord,
  submittedCities: JsonRecord[] = [],
): boolean {
  try {
    verifyValidatedDepartureCityReadback(payload, submittedCities);
    return true;
  } catch {
    return false;
  }
}
