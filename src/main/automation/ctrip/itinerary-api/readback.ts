/**
 * itinerary-api/readback 入口（barrel）：
 *   - types.ts：InfoRecord / PoiRecord / HotelRecord / StationPackageRecord 等窄类型，
 *     poiIdOf / poiNameOf / hotelNameOf / hotelTierOf / isAttraction / isMeal / isHotel
 *     / isGather / isDismiss / stationCode / stationName 等安全字段读取；
 *   - checks.ts：checkTitle / checkDailyUseCar / checkPois / checkMeals / checkHotels
 *     + matchHotelSlots / checkPickup / checkDropoff；
 *   - verifyItineraryReadback 入口。
 *
 * 错误信息必含「第 N 天 / 字段 / 期望 / 实际」，方便定位。
 */

import type { ReadbackExpectations } from "./itinerary-transform.js";
import { checkReadbackActivities, checkReadbackTimeline } from "./readback-activities.js";
import { checkServiceCards } from "./readback-service-cards.js";
import { fetchTourDailyDetail } from "./steps.js";
import type { ApiPage } from "./transport.js";
import {
  asInfoArray,
  type InfoRecord,
  type PoiRecord,
  type HotelRecord,
  type StationPackageRecord,
} from "./readback/types.js";
import {
  checkDailyUseCar,
  checkDropoff,
  checkHotels,
  checkMeals,
  checkPickup,
  checkPois,
  checkTitle,
} from "./readback/checks.js";

export interface VerifyReadbackSummary {
  days: number;
  spots: number;
  meals: number;
  hotels: number;
  sample: unknown;
}

export type {
  InfoRecord,
  PoiRecord,
  HotelRecord,
  StationPackageRecord,
} from "./readback/types.js";

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
    checkDailyUseCar(dayLabel, exp.useCar, day.useCar);
    totalSpots += checkPois(dayLabel, exp.pois, infos);
    totalMeals += checkMeals(dayLabel, exp.meals, infos);
    totalHotels += checkHotels(dayLabel, exp.hotels, infos);
    checkServiceCards(dayLabel, exp, infos);
    checkReadbackActivities(dayLabel, exp.activities, infos);
    checkReadbackTimeline(dayLabel, exp.timeline, infos);

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