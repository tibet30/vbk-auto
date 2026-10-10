/**
 * 多出发城市读取 + 选择：
 *   - compatibleDepartureCities：从 VBK 接口读取多出发城市（按 variant 过滤机场 / 火车站）；
 *   - selectTrafficLineValidationCities：只校验 VBK「热门」出发城市；字母分组仅用于
 *     补齐交通能力字段。
 *
 * 选择规则：
 *   - 必须具备 variant 对应的 hasAirport / hasTrain 能力；
 *   - 必须排除目的地同 ID / 同名（去掉市）城市；
 *   - 优先取"热门"分组，其余按字母分组能力补齐。
 */

import { list, postTrafficLineSoa, record, text, type JsonRecord, type TrafficLinePage } from "../client.js";
import type { TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";

type City = JsonRecord;

export async function compatibleDepartureCities(page: TrafficLinePage, variant: TrafficLineVariant, destination: City): Promise<City[]> {
  const payload = await postTrafficLineSoa(page, "15638", "getMultiDepartureCities.json", {}, "读取多出发城市");
  return selectTrafficLineValidationCities(list(payload.multiDepartureCities), variant, destination);
}

/**
 * 只校验 VBK「热门」出发城市；字母分组仅用于补齐交通能力字段。
 */
export function selectTrafficLineValidationCities(groups: JsonRecord[], variant: TrafficLineVariant, destination: City): City[] {
  const key = variant === "flightRoundTrip" ? "hasAirport" : "hasTrain";
  const destinationId = text(destination.cityId);
  const destinationName = text(destination.cityName).replace(/市$/, "");
  const capabilityById = new Map<string, City>();
  for (const city of groups.flatMap((group) => list(group.departureCities))) {
    const cityId = text(city.cityId);
    if (cityId && city[key] === true) capabilityById.set(cityId, city);
  }
  const hot = groups.find((group) => group != null && text((group as City).category) === "热门");
  const preferred = hot ? list((hot as City).departureCities as unknown as JsonRecord) : [...capabilityById.values()];
  const selected = new Map<string, City>();
  for (const city of preferred) {
    const cityId = text(city.cityId);
    const capable = capabilityById.get(cityId);
    if (!capable || cityId === destinationId || text(capable.cityName).replace(/市$/, "") === destinationName) continue;
    selected.set(cityId, capable);
  }
  return [...selected.values()];
}