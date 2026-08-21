/**
 * itinerary-api/readback.ts：
 *   - 字段级回读校验：verifyItineraryReadback
 *   - 单个 info 节点的类型 + 字段提取 helpers
 *   - 回读结果摘要类型 VerifyReadbackSummary
 *
 * 校验项（每日逐项）：
 *   - dailyDescription.title；
 *   - 景点 POI（poiId + poiName 顺序）；
 *   - 酒店（hotelName + hotelTier，业务有酒店时必存在）；
 *   - 其他 / 自由活动 description；
 *   - 服务时间（startOnBoardTime / stopOnBoardTime）；
 *   - 首日集合 / 接站（tourDailyPackageGatherList）；
 *   - 末日解散 / 送站（tourDailyPackageDismissList）；
 *   - 三餐（dinnerType key 顺序 + includeAdult 费用状态）。
 *
 * 错误信息必含「第 N 天 / 字段 / 期望 / 实际」，方便定位。
 */

import type { ReadbackExpectations } from "./itinerary-transform.js";
import { fetchTourDailyDetail } from "./steps.js";
import type { ApiPage } from "./transport.js";

export interface VerifyReadbackSummary {
  days: number;
  spots: number;
  meals: number;
  hotels: number;
  sample: unknown;
}

/** 单个 info 节点的安全类型（用于字段级比对）。 */
interface InfoRecord {
  activeType?: { key?: unknown; name?: unknown };
  description?: unknown;
  startOnBoardTime?: unknown;
  stopOnBoardTime?: unknown;
  tourDailyPois?: Array<Record<string, unknown>>;
  tourDailyHotels?: Array<Record<string, unknown>>;
  tourDailyDinner?: {
    dinnerType?: { key?: unknown; name?: unknown };
    includeAdult?: { key?: unknown; name?: unknown };
  };
  tourDailyPackageGatherList?: StationPackageRecord[];
  tourDailyPackageDismissList?: StationPackageRecord[];
}

interface StationPackageRecord {
  airports?: unknown[];
  trainStations?: unknown[];
  serviceAllDay?: unknown;
  useCar?: { key?: unknown };
}

interface PoiRecord {
  poi?: { poiId?: unknown; poiName?: unknown };
}

interface HotelRecord {
  hotel?: { hotelName?: unknown; grade?: { name?: unknown } };
}

function asInfoArray(value: unknown): InfoRecord[] {
  if (!Array.isArray(value)) return [];
  return value as InfoRecord[];
}

function poiIdOf(poi: PoiRecord | undefined): number {
  if (!poi?.poi) return 0;
  const id = poi.poi.poiId;
  return typeof id === "number" ? id : Number(id ?? 0);
}

function poiNameOf(poi: PoiRecord | undefined): string {
  return String(poi?.poi?.poiName ?? "").trim();
}

function hotelNameOf(hotel: HotelRecord | undefined): string {
  return String(hotel?.hotel?.hotelName ?? "").trim();
}

function hotelTierOf(hotel: HotelRecord | undefined): string {
  return String(hotel?.hotel?.grade?.name ?? "").trim();
}

function isAttraction(info: InfoRecord): boolean {
  return info.activeType?.key === 3 || info.activeType?.name === "景点";
}
function isMeal(info: InfoRecord): boolean {
  return info.activeType?.key === 0 || info.activeType?.name === "餐饮";
}
function isHotel(info: InfoRecord): boolean {
  return info.activeType?.key === 1 || info.activeType?.name === "酒店";
}
function isOther(info: InfoRecord): boolean {
  return info.activeType?.key === 7 || info.activeType?.name === "自由活动";
}
function isGather(info: InfoRecord): boolean {
  return info.activeType?.key === 25 || info.activeType?.name === "集合";
}
function isDismiss(info: InfoRecord): boolean {
  return info.activeType?.key === 26 || info.activeType?.name === "解散";
}

function stationCode(value: unknown, kind: "air" | "train"): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return String(kind === "air" ? record.code ?? "" : record.locationCode ?? record.stationNo ?? "");
}

function stationName(value: unknown, kind: "air" | "train"): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return String(kind === "air" ? record.name ?? "" : record.stationName ?? "");
}

/** 校验 dailyDescription.title。 */
function checkTitle(dayLabel: string, expected: string, actualRaw: unknown): void {
  const actual = String(actualRaw ?? "").trim();
  if (actual !== expected) {
    throw new Error(`${dayLabel} 回读 title 不一致：期望=${JSON.stringify(expected)}，实际=${JSON.stringify(actual)}`);
  }
}

/** 校验景点 POI：poiId + poiName 顺序。 */
function checkPois(dayLabel: string, expected: Array<{ poiId: number; poiName: string }>, actualInfos: InfoRecord[]): number {
  const attractions = actualInfos.filter(isAttraction);
  if (!attractions.length) throw new Error(`${dayLabel} 回读缺少景点节点`);
  const allPois = attractions.flatMap((a) => Array.isArray(a.tourDailyPois) ? a.tourDailyPois as PoiRecord[] : []);
  if (expected.length !== allPois.length) {
    throw new Error(
      `${dayLabel} 回读景点 POI 数量不一致：期望 ${expected.length} 个，实际 ${allPois.length} 个`,
    );
  }
  let count = 0;
  expected.forEach((expPoi, idx) => {
    const actualId = poiIdOf(allPois[idx]);
    const actualName = poiNameOf(allPois[idx]);
    if (actualId !== expPoi.poiId) {
      throw new Error(`${dayLabel} 第 ${idx + 1} 个景点 poiId 不一致：期望=${expPoi.poiId}，实际=${actualId}`);
    }
    if (actualName !== expPoi.poiName) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 个景点 poiName 不一致：期望=${JSON.stringify(expPoi.poiName)}，实际=${JSON.stringify(actualName)}`,
      );
    }
    count += 1;
  });
  return count;
}

/** 校验三餐：dinnerType key 顺序 + includeAdult 费用状态。 */
function checkMeals(dayLabel: string, expected: Array<{ key: "B" | "L" | "S"; mealsIncluded: boolean }>, actualInfos: InfoRecord[]): number {
  const meals = actualInfos.filter(isMeal);
  if (meals.length !== 3) throw new Error(`${dayLabel} 回读餐饮节点数=${meals.length}，期望 3`);
  let count = 0;
  meals.forEach((meal, idx) => {
    const exp = expected[idx];
    if (!exp) throw new Error(`${dayLabel} 回读第 ${idx + 1} 段餐饮无对应期望`);
    const actualKey = meal.tourDailyDinner?.dinnerType?.key ?? null;
    if (actualKey !== exp.key) {
      throw new Error(`${dayLabel} 第 ${idx + 1} 段餐饮 dinnerType key 不一致：期望=${exp.key}，实际=${String(actualKey)}`);
    }
    const actualIncluded = meal.tourDailyDinner?.includeAdult?.key;
    const expectedIncluded = exp.mealsIncluded ? "I" : "E";
    if (actualIncluded !== expectedIncluded) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 段餐饮 includeAdult 不一致：期望=${expectedIncluded}（${exp.mealsIncluded ? "费用包含" : "费用自理"}），实际=${String(actualIncluded)}`,
      );
    }
    count += 1;
  });
  return count;
}

/** 校验酒店：hotelName + hotelTier。 */
function checkHotels(
  dayLabel: string,
  expected: Array<{ hotelName: string; hotelTier?: string }>,
  actualInfos: InfoRecord[],
): number {
  const hotels = actualInfos.filter(isHotel);
  // 住宿按天校验：只有该天的期望里有住宿时才要求命中酒店节点。
  // 不能使用全程级的 requireHotels，否则 2天1晚产品的末日会被错误判为缺酒店。
  if (expected.length > 0 && !hotels.length) throw new Error(`${dayLabel} 回读缺少酒店节点（业务要求）`);
  if (expected.length !== hotels.length) {
    throw new Error(`${dayLabel} 回读酒店节点数不一致：期望 ${expected.length} 个，实际 ${hotels.length} 个`);
  }
  let count = 0;
  expected.forEach((expHotel, idx) => {
    const slot = hotels[idx]?.tourDailyHotels?.[0];
    const actualHotelName = hotelNameOf(slot);
    const actualHotelTier = hotelTierOf(slot);
    if (actualHotelName !== expHotel.hotelName) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 个酒店 hotelName 不一致：期望=${JSON.stringify(expHotel.hotelName)}，实际=${JSON.stringify(actualHotelName)}`,
      );
    }
    const expectedTier = expHotel.hotelTier ?? "";
    const description = String(hotels[idx]?.description ?? "");
    if (expectedTier && actualHotelTier !== expectedTier && !description.includes(expectedTier)) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 个酒店 hotelTier 不一致：期望=${JSON.stringify(expectedTier)}，实际 grade=${JSON.stringify(actualHotelTier)}，description=${JSON.stringify(description)}`,
      );
    }
    count += 1;
  });
  return count;
}

/** 校验「其他 / 自由活动」节点 description + 服务时间。 */
function checkOther(
  dayLabel: string,
  expected: { description: string; serviceTime: { startTime: string; endTime: string } },
  actualInfos: InfoRecord[],
): void {
  const others = actualInfos.filter(isOther);
  if (!others.length) throw new Error(`${dayLabel} 回读缺少「其他 / 自由活动」节点`);
  const otherDesc = String(others[0]?.description ?? "").trim();
  if (otherDesc !== expected.description) {
    throw new Error(
      `${dayLabel} 回读「其他」description 不一致：期望=${JSON.stringify(expected.description)}，实际=${JSON.stringify(otherDesc)}`,
    );
  }
  const startOnBoard = String(others[0]?.startOnBoardTime ?? "");
  const stopOnBoard = String(others[0]?.stopOnBoardTime ?? "");
  if (startOnBoard !== expected.serviceTime.startTime) {
    throw new Error(
      `${dayLabel} 回读服务时间 startOnBoardTime 不一致：期望=${expected.serviceTime.startTime}，实际=${JSON.stringify(startOnBoard)}`,
    );
  }
  if (stopOnBoard !== expected.serviceTime.endTime) {
    throw new Error(
      `${dayLabel} 回读服务时间 stopOnBoardTime 不一致：期望=${expected.serviceTime.endTime}，实际=${JSON.stringify(stopOnBoard)}`,
    );
  }
}

/** 校验首日集合卡片中的机场与火车站。 */
function checkPickup(
  dayLabel: string,
  expectations: ReadbackExpectations,
  actualInfos: InfoRecord[],
): void {
  const pickup = actualInfos.find(isGather);
  if (!pickup) throw new Error(`${dayLabel} 回读缺少集合节点`);
  const station = pickup.tourDailyPackageGatherList?.[0];
  if (!station) throw new Error(`${dayLabel} 集合节点缺 tourDailyPackageGatherList`);
  const expectedAirportCode = expectations.pickup.airport?.code ?? null;
  const expectedTrainCode = expectations.pickup.train?.code ?? null;
  const actualAirportCode = stationCode(station.airports?.[0], "air");
  const actualTrainCode = stationCode(station.trainStations?.[0], "train");
  if (expectedAirportCode && actualAirportCode !== expectedAirportCode) {
    throw new Error(`${dayLabel} 接机机场代码不一致：期望=${expectedAirportCode}，实际=${actualAirportCode}`);
  }
  if (expectedTrainCode && actualTrainCode !== expectedTrainCode) {
    throw new Error(`${dayLabel} 接站火车站代码不一致：期望=${expectedTrainCode}，实际=${actualTrainCode}`);
  }
  const expectedAirportName = expectations.pickup.airport?.name ?? null;
  const actualAirportName = stationName(station.airports?.[0], "air");
  if (expectedAirportName && actualAirportName !== expectedAirportName) {
    throw new Error(`${dayLabel} 接机机场名称不一致：期望=${JSON.stringify(expectedAirportName)}，实际=${JSON.stringify(actualAirportName)}`);
  }
  if (station.serviceAllDay !== true) {
    throw new Error(`${dayLabel} 集合服务时间不是全天：实际=${String(station.serviceAllDay)}`);
  }
}

/** 校验末日解散卡片中的机场与火车站。 */
function checkDropoff(
  orderDay: number,
  expectations: ReadbackExpectations,
  actualInfos: InfoRecord[],
): void {
  const dropoff = actualInfos.find(isDismiss);
  if (!dropoff) throw new Error(`末日（第 ${orderDay} 天）回读缺少解散节点`);
  const station = dropoff.tourDailyPackageDismissList?.[0];
  if (!station) throw new Error(`末日（第 ${orderDay} 天）解散节点缺 tourDailyPackageDismissList`);
  const expectedAirportCode = expectations.dropoff.airport?.code ?? null;
  const expectedTrainCode = expectations.dropoff.train?.code ?? null;
  const actualAirportCode = stationCode(station.airports?.[0], "air");
  const actualTrainCode = stationCode(station.trainStations?.[0], "train");
  if (expectedAirportCode && actualAirportCode !== expectedAirportCode) {
    throw new Error(`末日（第 ${orderDay} 天）送机机场代码不一致：期望=${expectedAirportCode}，实际=${actualAirportCode}`);
  }
  if (expectedTrainCode && actualTrainCode !== expectedTrainCode) {
    throw new Error(`末日（第 ${orderDay} 天）送站火车站代码不一致：期望=${expectedTrainCode}，实际=${actualTrainCode}`);
  }
  const expectedAirportName = expectations.dropoff.airport?.name ?? null;
  const actualAirportName = stationName(station.airports?.[0], "air");
  if (expectedAirportName && actualAirportName !== expectedAirportName) {
    throw new Error(`末日（第 ${orderDay} 天）送机机场名称不一致：期望=${JSON.stringify(expectedAirportName)}，实际=${JSON.stringify(actualAirportName)}`);
  }
  if (station.serviceAllDay !== true) {
    throw new Error(`末日（第 ${orderDay} 天）解散服务时间不是全天：实际=${String(station.serviceAllDay)}`);
  }
}

/**
 * 字段级回读校验：每个 day 都按 expectations 严格比对，错误信息必含
 * 「第 N 天 / 字段 / 期望 / 实际」。
 */
export async function verifyItineraryReadback(
  page: ApiPage,
  tourInfoId: string | number,
  expectations: ReadbackExpectations,
): Promise<VerifyReadbackSummary> {
  const detail = await fetchTourDailyDetail(page, tourInfoId);
  const descriptions = Array.isArray(detail.descriptions)
    ? detail.descriptions as Array<Record<string, unknown>>
    : [];
  const expectedDays = expectations.days.length;
  if (descriptions.length !== expectedDays) {
    throw new Error(`回读行程天数不一致：期望 ${expectedDays} 天，实际 ${descriptions.length} 天`);
  }

  let totalSpots = 0;
  let totalHotels = 0;
  let totalMeals = 0;
  const expectedDaysList = [...expectations.days].sort((a, b) => a.orderDay - b.orderDay);

  descriptions.forEach((day, dayIndex) => {
    const exp = expectedDaysList[dayIndex];
    if (!exp) throw new Error(`第 ${dayIndex + 1} 天回读无对应期望`);
    const dayLabel = `第 ${exp.orderDay} 天`;
    const infos = asInfoArray(day.tourDailyInfos);

    checkTitle(dayLabel, exp.title, day.dailyDescription);
    totalSpots += checkPois(dayLabel, exp.pois, infos);
    totalMeals += checkMeals(dayLabel, exp.meals, infos);
    totalHotels += checkHotels(dayLabel, exp.hotels, infos);
    checkOther(dayLabel, { description: exp.other.description, serviceTime: exp.serviceTime }, infos);

    if (dayIndex === 0) checkPickup(dayLabel, expectations, infos);
    if (dayIndex === descriptions.length - 1) checkDropoff(exp.orderDay, expectations, infos);
  });

  return {
    days: descriptions.length,
    spots: totalSpots,
    meals: totalMeals,
    hotels: totalHotels,
    sample: descriptions[0],
  };
}
