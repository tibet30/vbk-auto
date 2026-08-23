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
  }>;
  description: string;
  hotel: string;
  meals: string;
  mealDescriptions?: string[];
}

export interface ProductOperations {
  hotelTier?: string;
  pickupCity?: string;
  transport?: "charter" | "shared" | "none";
  reusePickupForDropoff?: boolean;
  mealsIncluded?: boolean;
}

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
  /** 餐饮三餐（顺序敏感：早 / 午 / 晚）。 */
  meals: Array<{
    key: "B" | "L" | "S";
    description: string;
    mealsIncluded: boolean;
  }>;
  /** 酒店节点（无酒店时为空数组）。 */
  hotels: Array<{ hotelName: string; hotelTier?: string }>;
  /** 其他 / 自由活动节点。 */
  other: { description: string };
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

const FIRST_DAY_DESCRIPTION_REPLACEMENTS = [
  { term: "巅峰", replacement: "高峰" },
] as const;

function sanitizeDayDescription(day: ProductItineraryDay): string {
  if (Number(day.day) !== 1 || typeof day.description !== "string") return day.description;
  return FIRST_DAY_DESCRIPTION_REPLACEMENTS.reduce((next, { term, replacement }) => next.split(term).join(replacement), day.description);
}

/**
 * 把项目侧 day 转成回读期望：title / pois / meals / hotel / description / serviceTime。
 */
export function buildReadbackExpectations(args: {
  itinerary: ProductItineraryDay[];
  operations: ProductOperations;
  stations: ResolvedStations;
}): ReadbackExpectations {
  const { itinerary, operations, stations } = args;
  const days: ReadbackDayExpectation[] = itinerary.map((day) => ({
    orderDay: day.day,
    title: day.title,
    pois: Array.isArray(day.spots)
      ? day.spots.map((s) => ({
          poiId: typeof s?.poiId === "number" ? s.poiId : 0,
          poiName: s?.poiName || s?.name || "",
        }))
      : [],
    meals: (["B", "L", "S"] as const).map((key, index) => ({
      key,
      description: day.mealDescriptions?.[index] ?? "",
      mealsIncluded: operations.mealsIncluded === true,
    })),
    hotels: day.hotel && day.hotel.trim()
      ? [{ hotelName: day.hotel, hotelTier: operations.hotelTier }]
      : [],
    other: { description: sanitizeDayDescription(day) },
    serviceTime: { startTime: "08:00", endTime: "20:00" },
  }));
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
 *   - 餐饮三段（早 / 午 / 晚）从 day.meals + mealDescriptions 派生；
 *   - 酒店节点可选（无酒店时不输出）；
 *   - 景点节点使用 buildAttractionPois 强校验；
 *   - 末尾追加「其他」节点，承载 day.description。
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
  if (!day.description || !day.description.trim()) {
    throw new Error(`第 ${day.day} 天 description 缺失（其他节点说明必填）。`);
  }
  const isFirst = index === 0;
  const isLast = index === totalDays - 1;
  const infos: Array<Record<string, unknown>> = [];
  let sort = 1;

  // 1) 接机 / 集合节点（仅首日）
  if (isFirst) {
    infos.push(buildPickupInfo({ stations, sort: sort++ }));
  }

  // 2) 景点节点（必须存在）
  const attractionPois = buildAttractionPois(day.spots);
  infos.push({
    tourDailyInfoId: null,
    takeoffTime: { key: "D", name: "全天" },
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
    sort,
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
  sort += 1;

  // 3) 餐饮三段（早 / 午 / 晚）
  const mealTypes: Array<{ key: "B" | "L" | "S"; index: 0 | 1 | 2 }> = [
    { key: "B", index: 0 },
    { key: "L", index: 1 },
    { key: "S", index: 2 },
  ];
  for (const meal of mealTypes) {
    const customDesc = day.mealDescriptions?.[meal.index];
    infos.push(
      buildMealInfo({
        sort: sort++,
        mealKey: meal.key,
        customDescription: customDesc,
        mealsIncluded: operations.mealsIncluded === true,
      }),
    );
  }

  // 4) 酒店节点（仅当 day.hotel 非空时输出；新增酒店资源由 hotelResource 阶段处理）
  if (day.hotel && day.hotel.trim()) {
    infos.push(
      buildHotelInfo({
        hotelName: day.hotel,
        hotelTier: operations.hotelTier,
        sort: sort++,
      }),
    );
  }

  // 5) 服务时间（占用时段）— 由 buildOtherInfo 的 serviceTime 注入；
  // 真实 detail 结构里「服务时间」是 tourDailyInfo 上的 startOnBoardTime /
  // stopOnBoardTime；这里保留兼容。

  // 6) 其他 / 自由活动节点（description 落到这里）
  infos.push(
    buildOtherInfo({
      description: sanitizeDayDescription(day),
      sort: sort++,
      serviceTime: { startTime: "08:00", endTime: "20:00" },
    }),
  );

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
