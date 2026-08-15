/**
 * itinerary-api/stations-resolver.ts：
 *   - 把 project.pickupCity + dropoffCity 翻译成 ResolvedStations（airport/train × pickup/dropoff）；
 *   - 多候选时按业务规则胜出，避免选错城市：
 *       机场：精确同名 > 「国际机场」/「${city}机场」> 首项；
 *       火车站：精确同名 > 首项；
 *   - 搜索委托给 station-search.ts（真实 soa2 接口）。
 *
 * 抽成独立模块是因为 pickAirport / pickTrain 是纯函数，便于：
 *   - 单元测试聚焦"候选排序"逻辑；
 *   - orchestrator 只关心 resolveStationsForCity 一个入口。
 */

import { searchAirports, searchTrainStations, type StationCandidate } from "./station-search.js";
import type { ResolvedStations } from "./itinerary-transform.js";

/**
 * 机场候选优先级：
 *   - 0 个：返回 null（不抛错，由调用方决定业务失败）；
 *   - 1 个：返回该候选；
 *   - 多候选：精确同名（name === city）> 含「国际机场」/「${city}机场」> 首项。
 */
export function pickAirport(
  candidates: StationCandidate[],
  city: string,
): StationCandidate | null {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.find((c) => c.name === city);
  if (exact) return exact;
  const primary = candidates.find(
    (c) => /国际机场$/.test(c.name) || c.name === `${city}机场`,
  );
  if (primary) return primary;
  return candidates[0];
}

/**
 * 火车站候选优先级：精确同名（name === city）> 首项；多候选时若 city 唯一匹配则用它。
 */
export function pickTrain(
  candidates: StationCandidate[],
  city: string,
): StationCandidate | null {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.find((c) => c.name === city);
  if (exact) return exact;
  return candidates[0];
}

/**
 * 用 project.pickupCity + dropoffCity 解析接送站：
 *   - 先查 suggestAirport，再查 suggestTrainStation；
 *   - 多候选时按业务规则胜出；
 *   - 找不到（list 空）→ 返回 null，由调用方决定是否抛错。
 */
export async function resolveStationsForCity(
  page: { evaluate: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T> },
  city: string,
): Promise<ResolvedStations> {
  const trimmed = (city ?? "").trim();
  if (!trimmed) {
    throw new Error("接送站搜索城市为空");
  }
  const [airports, trains] = await Promise.all([
    searchAirports(page, trimmed),
    searchTrainStations(page, trimmed),
  ]);
  const air = pickAirport(airports, trimmed);
  const train = pickTrain(trains, trimmed);
  return { pickupAir: air, pickupTrain: train, dropoffAir: air, dropoffTrain: train };
}
