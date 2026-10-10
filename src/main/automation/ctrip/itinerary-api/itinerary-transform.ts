/**
 * itinerary 转换层主入口：
 *   - 类型声明（ProductItineraryDay / ProductOperations / ResolvedStations /
 *     VbkTourDailyDescription）；
 *   - 拼装单天 VBK tourDailyDescription 的 buildDayDescription；
 *   - 全量转换 transformItinerary（入口）；
 *   - 回读期望生成 buildReadbackExpectations（让 verifyItineraryReadback
 *     拿到逐字段期望）。
 *
 * 节点构造器（buildPickupInfo / buildDropoffInfo / buildMealInfo / buildHotelInfo /
 * buildAttractionPois / buildOtherInfo）拆到 info-builders.ts；
 * 字段空占位（emptyPoiSkeleton / emptyTourDailyPoi 等）拆到 info-skeletons.ts。
 *
 * 关于 refIdSeed：
 *   - 真实 detail 样本里 refId 字段都是 null，Tour Helper 新建行程时也置 null；
 *   - 这里把 refIdSeed 留作"运行级 nonce"，仅用于日志 / 调试关联，不参与
 *     VBK 协议字段写入；业务上不要求纯数字、不参与 URL 或 query 拼接。
 */

import { orderItineraryMeals } from "./meal-order.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT, ITINERARY_HOTEL_CANDIDATE_COUNT } from "../../../../shared/hotel-candidate-counts.js";
import { hasItineraryHotelStay } from "../../../../shared/itinerary-hotel.js";
import { normaliseItinerarySupport, dayHasTransportArrangement } from "../../../../shared/itinerary-support-arrangements.js";
import { toVbkDailyUseCar } from "../../../../shared/product-form.js";
import { HOTEL_SELECTION_NOTE, dailyTransportDescription } from "../../../../shared/itinerary-service-copy.js";
import { itineraryAttractions, effectiveItinerarySpotKind } from "../../../../shared/itinerary-activity-kind.js";
import { effectiveTimedSpots, dayOtherActivities, buildAttractionInfo, dayTimeline, otherDescriptionForActivity } from "./itinerary-timeline.js";
import type { ProductItineraryDay, ProductOperations, VbkTourDailyDescription, ResolvedStations, ReadbackDayExpectation, ReadbackExpectations } from "./itinerary-types.js";
export type { ProductItineraryDay, ProductOperations, VbkTourDailyDescription, ResolvedStations, ReadbackDayExpectation, ReadbackExpectations } from "./itinerary-types.js";
import {
  attractionTicketSuffix,
  buildDropoffInfo,
  buildDailyTransportInfo,
  buildHotelInfo,
  buildMealInfo,
  buildFreeInfo,
  buildOtherInfo,
  buildPickupInfo,
  hotelTierPresentation,
} from "./info-builders.js";

/**
 * 早餐是否包含取决于最终酒店房型，不能依赖旧产品快照是否已有 mealDescriptions。
 * 录入转换是历史产品单阶段重跑的最终入口，必须在这里兜底写入平台餐饮卡片。
 */
export const HOTEL_ROOM_BREAKFAST_NOTE = "是否含餐，以酒店房型为准。";

/**
 * 把项目侧 day 转成回读期望：title / pois / meals / hotel / 必要时的其他 / serviceTime。
 */
export function buildReadbackExpectations(args: {
  itinerary: ProductItineraryDay[];
  operations: ProductOperations;
  stations: ResolvedStations;
}): ReadbackExpectations {
  const { itinerary, operations, stations } = args;
  const days: ReadbackDayExpectation[] = itinerary.map((rawDay, index) => {
    const day = normaliseItinerarySupport(rawDay);
    const activities = dayOtherActivities(day);
    return {
      orderDay: day.day,
      title: day.title,
      pois: Array.isArray(day.spots)
        ? itineraryAttractions(day.spots).map((s) => ({
            poiId: typeof s?.poiId === "number" ? s.poiId : 0,
            poiName: s?.poiName || s?.name || "",
            ...(s?.description?.trim() ? { description: s.description.trim() } : {}),
            suffixKey: attractionTicketSuffix(s).key,
          }))
        : [],
      meals: (mealTypesForDay({ index, totalDays: itinerary.length })).map(({ key, index: mealIndex }) => ({
        key,
        description: mealDescription(day, key, mealIndex),
        mealsIncluded: key === "B" && operations.mealsIncluded === true,
      })),
      hotels: hotelNamesForDay(day).map((hotelName) => ({ hotelName, hotelTier: hotelRatingForDay(day, operations.hotelTier), selectionNote: HOTEL_SELECTION_NOTE })),
      transport: operations.transport === "charter" ? { description: dailyTransportDescription(day.title) } : undefined,
      useCar: toVbkDailyUseCar(operations.transport),
      activities: activities.map((activity) => ({
        kind: activity.type === "free" ? "free" : "other",
        description: otherDescriptionForActivity(activity), time: activity.time, durationMinutes: activity.durationMinutes,
      })),
      timeline: dayTimeline(day),
      serviceTime: { startTime: "08:00", endTime: "20:00" },
    };
  });
  return {
    days,
    pickup: {
      airport: stations.pickupAir ? { code: stations.pickupAir.code, name: stations.pickupAir.name } : null,
      train: stations.pickupTrain ? { code: stations.pickupTrain.code, name: stations.pickupTrain.name } : null,
    },
    dropoff: {
      airport: stations.dropoffAir ? { code: stations.dropoffAir.code, name: stations.dropoffAir.name } : null,
      train: stations.dropoffTrain ? { code: stations.dropoffTrain.code, name: stations.dropoffTrain.name } : null,
    },
    requireHotels: itinerary.some((day) => hotelNamesForDay(day).length > 0),
  };
}

/**
 * 拼装单天 VBK tourDailyDescription：
 *   - 接机 / 送机节点仅出现在首日 / 末日；
 *   - 首日不写早餐、尾日不写晚餐；午餐在上午与下午景点之间，酒店为当天末项；
 *   - 酒店节点可选（无酒店时不输出）；
 *   - 景点节点使用 buildAttractionPois 强校验；
 *   - 末尾仅在存在未匹配的用户活动时追加「其他」节点。
 *
 * 输出的每个 info 都保留 VBK 模板的全部字段，未知字段保持 null 让后端默认填。
 */
export function buildDayDescription(args: {
  day: ProductItineraryDay;
  index: number;
  totalDays: number;
  operations: ProductOperations;
  stations: ResolvedStations;
}): VbkTourDailyDescription {
  const { index, totalDays, operations, stations } = args;
  const day = normaliseItinerarySupport(args.day);
  if (!day.title || !day.title.trim()) {
    throw new Error(`第 ${day.day} 天 title 缺失（行程标题必填）。`);
  }
  const isFirst = index === 0;
  const isLast = index === totalDays - 1;
  const infos: Array<Record<string, unknown>> = [];
  let sort = 1;

  // 1) 接机 / 集合节点（仅首日）
  if (isFirst) {
    infos.push(buildPickupInfo({ stations, sort: sort++ }));
  }

  // 2) 首日不安排早餐；其他日期的早餐是否包含由酒店房型决定。
  if (!isFirst) {
    infos.push(buildMealInfo({
      sort: sort++,
      mealKey: "B",
      customDescription: HOTEL_ROOM_BREAKFAST_NOTE,
      mealsIncluded: operations.mealsIncluded === true,
    }));
  }

  if (operations.transport === "charter") infos.push(buildDailyTransportInfo(day.title, sort++));

  // 3) 景点节点（可由用户明确的“其他”活动替代）。景点按上午/下午拆开，
  // 让餐食自然落在两段游览之间，而不是把全天景点堆在三餐之前。
  const sourceSpots = Array.isArray(day.spots) ? day.spots : [];
  const attractionSpots = itineraryAttractions(sourceSpots);
  const hasSpots = attractionSpots.length > 0;
  const otherActivities = dayOtherActivities(day);
  if (!hasSpots && !otherActivities.length && !dayHasTransportArrangement(day)) {
    throw new Error(`第 ${day.day} 天缺少已验证景点或用户明确的其他活动。`);
  }
  let lunchAdded = false;
  const timedSpots = effectiveTimedSpots(sourceSpots);
  for (let position = 0; position < timedSpots.length;) {
    const entry = timedSpots[position];
    if (entry.timeOfDay === "afternoon" && !lunchAdded) {
      infos.push(buildMealInfo({ sort: sort++, mealKey: "L", customDescription: day.mealDescriptions?.[1], mealsIncluded: false }));
      lunchAdded = true;
    }
    if (entry.kind !== "attraction") {
      const activityTime = entry.timeOfDay === "morning" ? "上午" : "下午";
      const description = `${activityTime} ${entry.spot.name}：${entry.spot.description?.trim() || entry.spot.name}`;
      const args = { description, sort: sort++, serviceTime: { startTime: "08:00", endTime: "20:00" }, activityTime, durationMinutes: undefined };
      infos.push(entry.kind === "free" ? buildFreeInfo(args) : buildOtherInfo(args));
      position += 1;
      continue;
    }
    const run = [entry.spot]; position += 1;
    while (position < timedSpots.length && timedSpots[position].kind === "attraction" && timedSpots[position].timeOfDay === entry.timeOfDay) run.push(timedSpots[position++].spot);
    infos.push(buildAttractionInfo(run, entry.timeOfDay, sort++));
  }
  if (!lunchAdded) {
    infos.push(buildMealInfo({
      sort: sort++, mealKey: "L", customDescription: day.mealDescriptions?.[1], mealsIncluded: false,
    }));
  }

  // 4) 其他 / 自由活动承载无法匹配真实 POI 的用户活动；输出前按活动时间安放餐饮节点。
  if (otherActivities.length) {
    // Legacy activities have no unified spots order.  Retain them after migrated
    // timeline entries; new data always supplies its order through spots.
    for (const activity of otherActivities.filter((activity) => !sourceSpots.some((spot) => spot.name === activity.title && effectiveItinerarySpotKind(spot) === activity.type))) {
      const args = {
        description: otherDescriptionForActivity(activity), sort: sort++, serviceTime: { startTime: "08:00", endTime: "20:00" },
        activityTime: activity.time, durationMinutes: activity.durationMinutes,
      };
      infos.push(activity.type === "free" ? buildFreeInfo(args) : buildOtherInfo(args));
    }
  }

  // 5) 非尾日的晚餐；午、晚餐均为自理。
  if (!isLast) {
    infos.push(buildMealInfo({
      sort: sort++, mealKey: "S", customDescription: day.mealDescriptions?.[2], mealsIncluded: false,
    }));
  }

  // 6) 酒店节点。同一节点内的多条 hotel 记录才会被携程展示为“或”关系；
  // 不能拆成连续的三段“酒店”活动。
  const hotelNames = hotelNamesForDay(day);
  if (hotelNames.length) {
    infos.push(
      buildHotelInfo({
        hotelName: hotelNames[0],
        hotelNames,
        hotelTier: hotelRatingForDay(day, operations.hotelTier),
        sort: sort++,
      }),
    );
  }

  // 7) 送机 / 解散节点（仅末日）
  if (isLast) {
    infos.push(buildDropoffInfo({ stations, sort: sort++ }));
  }

  return {
    tourDailyDescriptionId: null,
    orderDay: index + 1,
    dailyDescription: day.title,
    useCar: toVbkDailyUseCar(operations.transport),
    tourDailyLocations: [],
    tourDailyInfos: orderItineraryMeals(infos),
    seaCruise: false,
    subDesc: "",
    dailyHighlights: [],
  };
}

type MealType = { key: "B" | "L" | "S"; index: 0 | 1 | 2 };

function mealDescription(day: ProductItineraryDay, key: MealType["key"], index: MealType["index"]): string {
  return key === "B" ? HOTEL_ROOM_BREAKFAST_NOTE : day.mealDescriptions?.[index] ?? "";
}

/** 客户可见评级来自当晚实际住宿；全程目标档次不能冒充降档结果。 */
function hotelRatingForDay(day: ProductItineraryDay, targetTier?: string): string | undefined {
  const candidate = day.hotelCandidates?.[0];
  const diamond = candidate?.diamond ?? day.hotelRequirement?.diamond;
  const type = candidate?.ratingType ?? day.hotelRequirement?.ratingType;
  if (diamond === 0) return "当地酒店";
  if (diamond && diamond >= 1 && diamond <= 5) {
    return type === "star" ? `${diamond}星酒店` : type === "homestay" ? `${diamond}钻民宿` : `当地${diamond}钻酒店`;
  }
  return hotelTierPresentation(targetTier).displayName ?? undefined;
}

function hotelNamesForDay(day: ProductItineraryDay): string[] {
  const candidates = Array.isArray(day.hotelCandidates)
    ? day.hotelCandidates.map((candidate) => candidate?.hotelName?.trim()).filter((name): name is string => Boolean(name))
    : [];
  if (candidates.length === 0) return hasItineraryHotelStay(day.hotel) ? [day.hotel.trim()] : [];
  if (candidates.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT || candidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT
    || new Set(candidates).size !== candidates.length) {
    throw new Error(`第 ${day.day} 天酒店候选必须是 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT}-${HOTEL_RESOURCE_CANDIDATE_COUNT} 家不同的酒店。`);
  }
  return candidates.slice(0, ITINERARY_HOTEL_CANDIDATE_COUNT);
}

function mealTypesForDay(args: { index: number; totalDays: number }): MealType[] {
  const meals: MealType[] = [];
  if (args.index > 0) meals.push({ key: "B", index: 0 });
  meals.push({ key: "L", index: 1 });
  if (args.index < args.totalDays - 1) meals.push({ key: "S", index: 2 });
  return meals;
}

function splitSpotsByTimeOfDay(spots: NonNullable<ProductItineraryDay["spots"]>) {
  const explicitlyTimed = spots.some((spot) => spot.timeOfDay);
  const morning = explicitlyTimed
    ? spots.filter((spot) => spot.timeOfDay !== "afternoon")
    : spots.slice(0, Math.ceil(spots.length / 2));
  const afternoon = explicitlyTimed
    ? spots.filter((spot) => spot.timeOfDay === "afternoon")
    : spots.slice(Math.ceil(spots.length / 2));
  return [
    ...(morning.length ? [{ timeOfDay: "morning" as const, spots: morning }] : []),
    ...(afternoon.length ? [{ timeOfDay: "afternoon" as const, spots: afternoon }] : []),
  ];
}

/**
 * 把 product.itinerary + operations + stations 一次性转换为完整 tourDailyDescriptions。
 *  - 校验：每天 day 必填字段、spots 必有 poiId；
 *  - 校验：operations.pickupCity 必填（接送站搜索无法进行）；
 *  - 校验：接送站至少需要 1 个有效候选（air 或 train）。
 *
 * refIdSeed 是日志关联 nonce：允许任意字符串（包含空串）；不参与 VBK 协议字段。
 */
export function transformItinerary(args: {
  itinerary: ProductItineraryDay[];
  operations: ProductOperations;
  stations: ResolvedStations;
  refIdSeed?: string;
}): VbkTourDailyDescription[] {
  const { itinerary, operations, stations } = args;
  if (!Array.isArray(itinerary) || itinerary.length === 0) {
    throw new Error("行程数组为空，无法转换为 VBK tourDailyDescriptions。");
  }
  if (!operations.pickupCity || !operations.pickupCity.trim()) {
    throw new Error("operations.pickupCity 缺失：接送站搜索无法进行。");
  }
  // 接送站至少需要 1 个有效候选（air 或 train）
  const hasPickup = Boolean(stations.pickupAir || stations.pickupTrain);
  const hasDropoff = Boolean(stations.dropoffAir || stations.dropoffTrain);
  if (!hasPickup || !hasDropoff) {
    throw new Error(
      `接送站搜索未返回任何可用候选：pickup=${hasPickup}, dropoff=${hasDropoff}`,
    );
  }
  return itinerary.map((day, index) =>
    buildDayDescription({
      day,
      index,
      totalDays: itinerary.length,
      operations,
      stations,
    }),
  );
}
