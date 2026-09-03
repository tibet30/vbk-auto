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

import type { StationCandidate } from "./station-search.js";
import {
  buildAttractionPois,
  buildDropoffInfo,
  buildHotelInfo,
  buildMealInfo,
  buildOtherInfo,
  buildPickupInfo,
} from "./info-builders.js";

/**
 * 输入：项目侧行程 + operations。
 *   - day 字段：{ day, title, spots, description, hotel, meals, mealDescriptions? }
 *   - spots 字段：{ name, poiName?, poiId?, province?, city?, district? }（poiId 是 VBK 系统 POI 唯一 ID）
 */
export interface ProductItineraryDay {
  day: number;
  title: string;
  spots?: Array<{
    name: string;
    poiName?: string | null;
    poiId?: number | null;
    province?: string | null;
    city?: string | null;
    district?: string | null;
    poiType?: { key: number; name: string } | null;
    ticketType?: { key: number; name: string } | null;
    poiData?: Record<string, unknown>;
    /** 规划层已按时段排好顺序；缺省时按 spots 顺序均分上午/下午。 */
    timeOfDay?: "morning" | "afternoon";
  }>;
  description: string;
  hotel: string;
  meals: string;
  mealDescriptions?: string[];
  activities?: Array<{
    time: string;
    title: string;
    detail: string;
    type?: "transport" | "visit" | "meal" | "hotel" | "free" | "other";
    durationMinutes?: number;
    source?: "user" | "ai";
  }>;
}

export interface ProductOperations {
  hotelTier?: string;
  pickupCity?: string;
  transport?: "charter" | "shared" | "none";
  reusePickupForDropoff?: boolean;
  mealsIncluded?: boolean;
}

/**
 * 早餐是否包含取决于最终酒店房型，不能依赖旧产品快照是否已有 mealDescriptions。
 * 录入转换是历史产品单阶段重跑的最终入口，必须在这里兜底写入平台餐饮卡片。
 */
export const HOTEL_ROOM_BREAKFAST_NOTE = "是否含餐，以酒店房型为准。";

/**
 * 输出：VBK 协议 detail.tourInfo.tourDailyDescriptions。
 * 这里只声明外层结构，便于单测做类型断言；具体每个 info 的形状由 builder 构造。
 */
export interface VbkTourDailyDescription {
  tourDailyDescriptionId: number | null;
  orderDay: number;
  dailyDescription: string;
  tourDailyLocations: Array<Record<string, unknown>>;
  tourDailyInfos: Array<Record<string, unknown>>;
  seaCruise: boolean;
  subDesc: string;
  dailyHighlights: unknown[];
}

/** 接送站（机场/火车）解析结果，由 station-search 返回。 */
export interface ResolvedStations {
  /** 接机机场（pickup 当天 airport）；不存在时为 null。 */
  pickupAir?: StationCandidate | null;
  /** 接机火车站；不存在时为 null。 */
  pickupTrain?: StationCandidate | null;
  /** 送机机场；不存在时为 null。 */
  dropoffAir?: StationCandidate | null;
  /** 送机火车站；不存在时为 null。 */
  dropoffTrain?: StationCandidate | null;
  /** 是否使用了多选 fallback（如 AI 选中）；用于日志诊断。 */
  source?: "exact" | "single" | "fallback-first" | "primary-airport" | "ai";
}

/**
 * 单天回读期望（由 buildReadbackExpectations 生成）。verifyItineraryReadback
 * 会按 orderDay 顺序逐项比对，错误信息含「第 N 天 / 字段 / 期望 / 实际」。
 */
export interface ReadbackDayExpectation {
  orderDay: number;
  title: string;
  /** 景点 POI 列表（顺序敏感）。 */
  pois: Array<{ poiId: number; poiName: string }>;
  /** 当日餐饮（顺序敏感：首日午/晚；中间日早/午/晚；尾日早/午）。 */
  meals: Array<{
    key: "B" | "L" | "S";
    description: string;
    mealsIncluded: boolean;
  }>;
  /** 酒店节点（无酒店时为空数组）。 */
  hotels: Array<{ hotelName: string; hotelTier?: string }>;
  /** 仅未匹配的用户活动才写入其他 / 自由活动节点。 */
  other?: { description: string };
  /** 服务时间（其他节点写入 startOnBoardTime / stopOnBoardTime）。 */
  serviceTime: { startTime: string; endTime: string };
}

export interface ReadbackExpectations {
  days: ReadbackDayExpectation[];
  /** 接送站（首日接机 / 接站；末日送机 / 送站）。 */
  pickup: { airport?: { code: string; name: string } | null; train?: { code: string; name: string } | null };
  dropoff: { airport?: { code: string; name: string } | null; train?: { code: string; name: string } | null };
  /** 是否有酒店业务（业务要求 → 每天回读必须有酒店节点）。 */
  requireHotels: boolean;
}

function dayOtherActivities(day: ProductItineraryDay) {
  return (day.activities ?? []).filter((activity) =>
    activity.source === "user"
      && (activity.type === "other" || activity.type === "free")
      && typeof activity.time === "string" && Boolean(activity.time.trim())
      && typeof activity.title === "string" && Boolean(activity.title.trim())
      && typeof activity.detail === "string" && Boolean(activity.detail.trim()));
}

function otherDescription(day: ProductItineraryDay): string {
  const activities = dayOtherActivities(day);
  return activities.map((activity) => {
    const prefix = activity.time && activity.time !== "不限" ? `${activity.time} ` : "";
    return `${prefix}${activity.title}：${activity.detail}`;
  }).join("；");
}

/**
 * 把项目侧 day 转成回读期望：title / pois / meals / hotel / 必要时的其他 / serviceTime。
 */
export function buildReadbackExpectations(args: {
  itinerary: ProductItineraryDay[];
  operations: ProductOperations;
  stations: ResolvedStations;
}): ReadbackExpectations {
  const { itinerary, operations, stations } = args;
  const days: ReadbackDayExpectation[] = itinerary.map((day, index) => {
    const activities = dayOtherActivities(day);
    return {
      orderDay: day.day,
      title: day.title,
      pois: Array.isArray(day.spots)
        ? day.spots.map((s) => ({
            poiId: typeof s?.poiId === "number" ? s.poiId : 0,
            poiName: s?.poiName || s?.name || "",
          }))
        : [],
      meals: (mealTypesForDay({ index, totalDays: itinerary.length })).map(({ key, index: mealIndex }) => ({
        key,
        description: mealDescription(day, key, mealIndex),
        mealsIncluded: key === "B" && operations.mealsIncluded === true,
      })),
      hotels: day.hotel && day.hotel.trim()
        ? [{ hotelName: day.hotel, hotelTier: operations.hotelTier }]
        : [],
      ...(activities.length ? { other: { description: otherDescription(day) } } : {}),
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
    requireHotels: itinerary.some((day) => Boolean(day.hotel && day.hotel.trim())),
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
  const { day, index, totalDays, operations, stations } = args;
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

  // 3) 景点节点（可由用户明确的“其他”活动替代）。景点按上午/下午拆开，
  // 让餐食自然落在两段游览之间，而不是把全天景点堆在三餐之前。
  const hasSpots = Array.isArray(day.spots) && day.spots.length > 0;
  const otherActivities = dayOtherActivities(day);
  if (!hasSpots && !otherActivities.length) {
    throw new Error(`第 ${day.day} 天缺少已验证景点或用户明确的其他活动。`);
  }
  if (hasSpots) {
    const periods = splitSpotsByTimeOfDay(day.spots!);
    let lunchAdded = false;
    for (const period of periods) {
      if (period.timeOfDay === "afternoon" && !lunchAdded) {
        infos.push(buildMealInfo({
          sort: sort++, mealKey: "L", customDescription: day.mealDescriptions?.[1], mealsIncluded: false,
        }));
        lunchAdded = true;
      }
      const attractionPois = buildAttractionPois(period.spots);
      infos.push({
      tourDailyInfoId: null,
      takeoffTime: period.timeOfDay === "morning"
        ? { key: null, name: "上午" }
        : { key: null, name: "下午" },
      takeoffEndTime: { name: "" },
      activeType: { key: 3, name: "景点" },
      sessionTimeType: 0,
      distance: 0,
      driveTime: 0,
      takeTime: 240,
      takeTimeType: 0,
      description: "",
      productsOnSale: "",
      specialGift: "",
      warmTips: "",
      sort: sort++,
      costInclude: false,
      tourDailyHotels: [],
      tourDailyTrains: [],
      tourDailyFlights: [],
      tourDailyPois: attractionPois,
      tourDailyThemes: [],
      tourDailyPackageGatherList: [],
      tourDailyPackageDismissList: [],
      tourDailyDistricts: [],
      tourDailyPackageFlights: [],
      tourDailyPackageTrains: [],
      tourDailyPackageIntermodals: [],
      tourDailyPackageShips: [],
      tourDailyPackageHotels: [],
      startOnBoardTime: "",
      stopOnBoardTime: "",
      communication: "",
      customStatus: 0,
      arriveTime: "",
      departTime: "",
      directionWay: { key: "", name: "" },
      recommendActivities: [],
      pkgProductId: 0,
      pkgTourInfoId: 0,
      pkgDayDesc: "",
      pkgShoppingId: "",
      versionNum: 0,
      });
      // 午餐必须在上午景点之后、下午景点之前。
      if (period.timeOfDay === "morning") {
        infos.push(buildMealInfo({
          sort: sort++,
          mealKey: "L",
          customDescription: day.mealDescriptions?.[1],
          mealsIncluded: false,
        }));
        lunchAdded = true;
      }
    }
  }

  // 没有景点、仅有用户明确的其他活动的日期，午餐仍需在活动之后补齐。
  if (!hasSpots) {
    infos.push(buildMealInfo({
      sort: sort++, mealKey: "L", customDescription: day.mealDescriptions?.[1], mealsIncluded: false,
    }));
  }

  // 4) 其他 / 自由活动仅承载无法匹配真实 POI 的用户活动，并置于晚餐/酒店前。
  if (otherActivities.length) {
    infos.push(
      buildOtherInfo({
        description: otherDescription(day),
        sort: sort++,
        serviceTime: { startTime: "08:00", endTime: "20:00" },
        activityTime: otherActivities[0]?.time,
        durationMinutes: otherActivities[0]?.durationMinutes,
      }),
    );
  }

  // 5) 非尾日的晚餐；午、晚餐均为自理。
  if (!isLast) {
    infos.push(buildMealInfo({
      sort: sort++, mealKey: "S", customDescription: day.mealDescriptions?.[2], mealsIncluded: false,
    }));
  }

  // 6) 酒店节点（仅当 day.hotel 非空时输出；新增酒店资源由 hotelResource 阶段处理）
  if (day.hotel && day.hotel.trim()) {
    infos.push(
      buildHotelInfo({
        hotelName: day.hotel,
        hotelTier: operations.hotelTier,
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
    tourDailyLocations: [],
    tourDailyInfos: infos,
    seaCruise: false,
    subDesc: "",
    dailyHighlights: [],
  };
}

type MealType = { key: "B" | "L" | "S"; index: 0 | 1 | 2 };

function mealDescription(day: ProductItineraryDay, key: MealType["key"], index: MealType["index"]): string {
  return key === "B" ? HOTEL_ROOM_BREAKFAST_NOTE : day.mealDescriptions?.[index] ?? "";
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
