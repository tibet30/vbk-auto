/**
 * itinerary-api/readback 字段级回读校验器：
 *   - checkTitle：dailyDescription.title 一致性；
 *   - checkDailyUseCar：当天用车 key / name 一致性；
 *   - checkPois：景点 POI（poiId + poiName + description + suffixKey 顺序）；
 *   - checkMeals：餐食 dinnerType key + 早餐 description + includeAdult 费用状态；
 *   - checkHotels + matchHotelSlots：酒店 hotelName + hotelTier（实际槽位必须是
 *     期望候选的非空子集，平台酒店可收敛备选）；
 *   - checkPickup / checkDropoff：首日集合 / 末日解散卡片中的机场 / 火车站。
 *
 * 错误信息必含「第 N 天 / 字段 / 期望 / 实际」，方便定位。
 */

import type { VbkDailyUseCar } from "../../../../../shared/product-form.js";
import type { ReadbackExpectations } from "../itinerary-transform.js";
import {
  hotelNameOf,
  hotelTierOf,
  isAttraction,
  isDismiss,
  isGather,
  isHotel,
  isMeal,
  poiIdOf,
  poiNameOf,
  stationCode,
  stationName,
  type HotelRecord,
  type InfoRecord,
  type PoiRecord,
} from "./types.js";

export function checkTitle(dayLabel: string, expected: string, actualRaw: unknown): void {
  const actual = String(actualRaw ?? "").trim();
  if (actual !== expected) {
    throw new Error(`${dayLabel} 回读 title 不一致：期望=${JSON.stringify(expected)}，实际=${JSON.stringify(actual)}`);
  }
}

/** 校验每天标题下的"当天用车"。 */
export function checkDailyUseCar(dayLabel: string, expected: VbkDailyUseCar, actualRaw: unknown): void {
  const record = actualRaw && typeof actualRaw === "object" && !Array.isArray(actualRaw)
    ? actualRaw as { key?: unknown; name?: unknown }
    : {};
  const actualKey = String(record.key ?? "");
  const actualName = String(record.name ?? "").trim();
  if (actualKey !== expected.key) {
    throw new Error(`${dayLabel} 当天用车不一致：期望=${expected.key}（${expected.name}），实际=${actualKey || JSON.stringify(record)}`);
  }
  if (actualName && actualName !== expected.name) {
    throw new Error(`${dayLabel} 当天用车名称不一致：期望=${JSON.stringify(expected.name)}，实际=${JSON.stringify(actualName)}`);
  }
}

export function checkPois(dayLabel: string, expected: Array<{ poiId: number; poiName: string; description?: string; suffixKey?: number }>, actualInfos: InfoRecord[]): number {
  if (expected.length === 0) return 0;
  const attractions = actualInfos.filter(isAttraction);
  if (!attractions.length) throw new Error(`${dayLabel} 回读缺少景点节点`);
  const allPois = attractions.flatMap((a) => Array.isArray(a.tourDailyPois)
    ? (a.tourDailyPois as PoiRecord[]).map((poi) => ({ poi, description: String(a.description ?? "").trim() })) : []);
  if (expected.length !== allPois.length) {
    throw new Error(
      `${dayLabel} 回读景点 POI 数量不一致：期望 ${expected.length} 个，实际 ${allPois.length} 个`,
    );
  }
  let count = 0;
  expected.forEach((expPoi, idx) => {
    const actual = allPois[idx];
    if (!actual) throw new Error(`${dayLabel} 第 ${idx + 1} 个景点回读缺失`);
    const actualId = poiIdOf(actual.poi);
    const actualName = poiNameOf(actual.poi);
    if (actualId !== expPoi.poiId) {
      throw new Error(`${dayLabel} 第 ${idx + 1} 个景点 poiId 不一致：期望=${expPoi.poiId}，实际=${actualId}`);
    }
    if (actualName !== expPoi.poiName) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 个景点 poiName 不一致：期望=${JSON.stringify(expPoi.poiName)}，实际=${JSON.stringify(actualName)}`,
      );
    }
    if (expPoi.description && !actual.description.includes(expPoi.description)) {
      throw new Error(`${dayLabel} 第 ${idx + 1} 个景点说明缺失：期望包含=${JSON.stringify(expPoi.description)}，实际=${JSON.stringify(actual.description)}`);
    }
    const actualSuffixKey = Number(actual.poi.suffixName?.key ?? 0);
    if (expPoi.suffixKey !== undefined && actualSuffixKey !== expPoi.suffixKey) {
      throw new Error(`${dayLabel} 第 ${idx + 1} 个景点门票标记不一致：期望=${expPoi.suffixKey}，实际=${actualSuffixKey}`);
    }
    count += 1;
  });
  return count;
}

export function checkMeals(dayLabel: string, expected: Array<{ key: "B" | "L" | "S"; description: string; mealsIncluded: boolean }>, actualInfos: InfoRecord[]): number {
  const meals = actualInfos.filter(isMeal);
  if (meals.length !== expected.length) {
    throw new Error(`${dayLabel} 回读餐饮节点数=${meals.length}，期望 ${expected.length}`);
  }
  let count = 0;
  meals.forEach((meal, idx) => {
    const exp = expected[idx];
    if (!exp) throw new Error(`${dayLabel} 回读第 ${idx + 1} 段餐饮无对应期望`);
    const actualKey = meal.tourDailyDinner?.dinnerType?.key ?? null;
    if (actualKey !== exp.key) {
      throw new Error(`${dayLabel} 第 ${idx + 1} 段餐饮 dinnerType key 不一致：期望=${exp.key}，实际=${String(actualKey)}`);
    }
    if (exp.key === "B") {
      const actualDescription = String(meal.description ?? "").trim();
      if (actualDescription !== exp.description) {
        throw new Error(
          `${dayLabel} 第 ${idx + 1} 段早餐补充说明不一致：期望=${JSON.stringify(exp.description)}，实际=${JSON.stringify(actualDescription)}`,
        );
      }
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

export function checkHotels(
  dayLabel: string,
  expected: Array<{ hotelName: string; hotelTier?: string }>,
  actualInfos: InfoRecord[],
): number {
  const hotels = actualInfos.filter(isHotel);
  if (expected.length > 0 && !hotels.length) throw new Error(`${dayLabel} 回读缺少酒店节点（业务要求）`);
  if (expected.length > 0 && hotels.length !== 1) {
    throw new Error(`${dayLabel} 回读酒店节点数不一致：期望 1 个含备选的酒店节点，实际 ${hotels.length} 个`);
  }
  const slots = hotels.flatMap((info) => (info.tourDailyHotels ?? []).map((slot) => ({ info, slot: slot as HotelRecord })));
  if (expected.length > 0 && !slots.length) throw new Error(`${dayLabel} 回读缺少酒店备选（业务要求）`);
  return matchHotelSlots(dayLabel, expected, slots);
}

export function matchHotelSlots(
  dayLabel: string,
  expected: Array<{ hotelName: string; hotelTier?: string }>,
  slots: Array<{ info: InfoRecord; slot: HotelRecord }>,
): number {
  let count = 0;
  slots.forEach(({ info, slot }, idx) => {
    const actualHotelName = hotelNameOf(slot);
    const actualHotelTier = hotelTierOf(slot);
    const description = String(info?.description ?? "");
    const matched = expected.find((expHotel) => expHotel.hotelName === actualHotelName)
      ?? (actualHotelName === "自选酒店"
        ? expected.find((expHotel) => description.includes(expHotel.hotelName))
        : undefined);
    if (!matched) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 个酒店 hotelName 不一致：实际=${JSON.stringify(actualHotelName)}，期望候选=${JSON.stringify(expected.map((hotel) => hotel.hotelName))}`,
      );
    }
    const expectedTier = matched.hotelTier ?? "";
    if (expectedTier && actualHotelTier !== expectedTier && !description.includes(expectedTier)) {
      throw new Error(
        `${dayLabel} 第 ${idx + 1} 个酒店 hotelTier 不一致：期望=${JSON.stringify(expectedTier)}，实际 grade=${JSON.stringify(actualHotelTier)}，description=${JSON.stringify(description)}`,
      );
    }
    count += 1;
  });
  return count;
}

export function checkPickup(
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

export function checkDropoff(
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