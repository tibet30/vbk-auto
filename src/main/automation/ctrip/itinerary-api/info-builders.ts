/**
 * tourDailyInfo 各节点构造器：把业务字段映射到 VBK 协议的 tourDailyInfo。
 *
 * 设计目标：
 *   - 每个 builder 返回的形状都与「真实 detail 抓回」一致，避免 check saveType=8/3
 *     触发字段缺失校验；
 *   - 共用字段（takeoffTime / takeoffEndTime / activeType / costInclude 等）从
 *     commonInfoFields 拿，确保节点间字段对齐；
 *   - buildAttractionPois 在 poiId / poiName 缺失时直接抛错（业务失败而不是
 *     隐式跳过）；
 *   - refId 一律为 null（真实 detail 样本里 refId 都是 null；不允许伪造字符串）。
 */

import type { ProductItineraryDay, ProductOperations, ResolvedStations } from "./itinerary-transform.js";
import {
  emptyPoiSkeleton,
  emptyTourDailyDinner,
  emptyTourDailyHotel,
  emptyTourDailyPoi,
} from "./info-skeletons.js";

/**
 * 共用字段：每个 tourDailyInfo 都需要这些键，让 VBK 校验能逐字段对齐。
 *  - activeType / sort / costInclude / description / 4 个 *Package* 列表等
 *    都在这里统一构造，避免每个 builder 重复写大段字段；
 *  - 业务节点只在差异字段（POI / Hotel / Flight …）上做覆盖。
 */
function commonInfoFields(args: {
  activeType: { key: number; name: string };
  sort: number;
  description?: string;
  takeoffTime?: { key?: string | null; name?: string };
  takeTime?: number;
  costInclude?: boolean;
  startOnBoardTime?: string;
  stopOnBoardTime?: string;
  arriveTime?: string;
  departTime?: string;
  directionWay?: { key: number | string; name: string | null };
}) {
  return {
    tourDailyInfoId: null,
    takeoffTime: args.takeoffTime ?? { key: "D", name: "全天" },
    takeoffEndTime: { name: "" },
    activeType: args.activeType,
    sessionTimeType: 0,
    distance: 0,
    driveTime: 0,
    takeTime: args.takeTime ?? 0,
    takeTimeType: 0,
    description: args.description ?? "",
    productsOnSale: "",
    specialGift: "",
    warmTips: "",
    sort: args.sort,
    costInclude: args.costInclude ?? false,
    tourDailyHotels: [],
    tourDailyTrains: [],
    tourDailyFlights: [],
    tourDailyPois: [],
    tourDailyThemes: [],
    tourDailyPackageGatherList: [],
    tourDailyPackageDismissList: [],
    tourDailyDistricts: [],
    tourDailyPackageFlights: [],
    tourDailyPackageTrains: [],
    tourDailyPackageIntermodals: [],
    tourDailyPackageShips: [],
    tourDailyPackageHotels: [],
    startOnBoardTime: args.startOnBoardTime ?? "",
    stopOnBoardTime: args.stopOnBoardTime ?? "",
    communication: "",
    customStatus: 0,
    arriveTime: args.arriveTime ?? "",
    departTime: args.departTime ?? "",
    directionWay: args.directionWay ?? { key: "", name: "" },
    recommendActivities: [],
    pkgProductId: 0,
    pkgTourInfoId: 0,
    pkgDayDesc: "",
    pkgShoppingId: "",
    versionNum: 0,
  };
}

/**
 * 把 project.itinerary 数组里 spots 的 poiId / name 规整为 VBK 协议的
 * tourDailyPois 元素。
 *  - spots 为空数组 → 抛错（业务要求每日至少 1 个 poiId 已验证的景点）；
 *  - 缺 poiId / poiName → 抛错（含位置信息便于排查）。
 */
export function buildAttractionPois(
  spots: ProductItineraryDay["spots"],
): Array<Record<string, unknown>> {
  const list = Array.isArray(spots) ? spots : [];
  if (!list.length) {
    throw new Error(`行程景点缺失：每日必须至少 1 个已验证 poiId 的景点`);
  }
  return list.map((spot, index) => {
    const poiId = typeof spot?.poiId === "number" ? spot.poiId : null;
    const poiName = spot?.poiName || spot?.name || "";
    if (!poiId || !poiName) {
      throw new Error(
        `第 ${index + 1} 个景点缺 poiId/poiName（已通过 suggestPoi 校验过的景点必须有 poiId）：${JSON.stringify(spot).slice(0, 200)}`,
      );
    }
    return {
      tourDailyPoiId: null,
      poi: {
        ...emptyPoiSkeleton(),
        ...(spot.poiData ?? {}),
        poiId,
        poiName,
        poiType: spot.poiType ?? { key: null, name: null },
        ticketType: spot.ticketType ?? null,
        currency: (spot.poiData?.currency as Record<string, unknown> | undefined) ?? {},
        costUnit: (spot.poiData?.costUnit as Record<string, unknown> | undefined) ?? { key: 1, name: "人" },
        relateSystemTicket: { key: "F", name: "否" },
        asyncValidateStatus: "success",
      },
      sort: index + 1,
      orFlag: true,
      suffixName: spot.ticketType?.key === 2
        ? { key: 11, name: "无需门票" }
        : { key: 7, name: "不含门票" },
      costInclude: { key: "", name: null },
      images: [],
      refId: null,
      parentId: null,
      poiSelfFundedActivities: [],
      groupType: { key: null, name: null },
      groupSort: null,
    };
  });
}

/** 首日集合节点。结构来自 VBK 当前页面「接机/站」后 saveType=2 的真实请求。 */
export function buildPickupInfo(args: {
  stations: ResolvedStations;
  sort: number;
}) {
  const { stations, sort } = args;
  const airportCode = stations.pickupAir?.code ?? "";
  const airportName = stations.pickupAir?.name ?? "";
  const trainCode = stations.pickupTrain?.code ?? "";
  const trainName = stations.pickupTrain?.name ?? "";
  return {
    ...commonInfoFields({
      activeType: { key: 25, name: "集合" },
      sort,
      takeoffTime: {},
      costInclude: false,
    }),
    transportation: {},
    tourDailyCar: {},
    tourDailyDinner: {},
    tourDailyImages: [],
    sightRecommend: {},
    fixedProductsOnSale: [],
    tourDailyPackageGatherList: [{
      tourDailyPackageGatherId: null,
      gatherMode: { key: 3, name: "接机/站" },
      airports: airportCode ? [{ code: airportCode, name: airportName }] : [],
      trainStations: trainCode ? [{ stationName: trainName, locationCode: trainCode }] : [],
      location: {},
      useCar: { key: "1", name: "专车" },
      serviceAllDay: true,
      pageIndex: 0,
    }],
  };
}

/**
 * 餐饮节点：activeType=0（餐饮），tourDailyDinner 包含三餐元数据。
 *  - 默认费用自理（E）；调用方仅在酒店房型确认含早餐时给早餐传 mealsIncluded=true；
 *  - 儿童统一费用自理（业务默认值）。
 */
export function buildMealInfo(args: {
  sort: number;
  mealKey: "B" | "L" | "S";
  /** 平台餐饮卡片的“补充说明”输入框。 */
  customDescription?: string;
  mealsIncluded: boolean;
}) {
  const { sort, mealKey, customDescription, mealsIncluded } = args;
  return {
    ...commonInfoFields({
      activeType: { key: 0, name: "餐饮" },
      sort,
      description: customDescription ?? "",
      takeoffTime: {
        key: null,
        name: mealKey === "B" ? "07:00" : mealKey === "L" ? "12:00" : "18:00",
      },
      takeTime: 60,
      costInclude: false,
    }),
    tourDailyPois: [emptyTourDailyPoi()],
    tourDailyDinner: emptyTourDailyDinner(mealKey, mealsIncluded),
  };
}

/**
 * 酒店节点：activeType=1（酒店），tourDailyHotels 携带一个空 hotel 占位。
 *  - 真实酒店资源（hotelId / hotelAddress / location 等）由 hotelResource 阶段
 *    补全，这里只把「酒店名称 + 钻级说明」落到 description 与 grade.name。
 */
export function buildHotelInfo(args: {
  hotelName: string;
  /** 同一晚的备选酒店；VBK 会把同一个节点内的多条记录渲染为“或”。 */
  hotelNames?: string[];
  hotelTier?: string;
  sort: number;
}) {
  const { hotelName, hotelNames, hotelTier, sort } = args;
  const names = hotelNames?.length ? hotelNames : [hotelName];
  return {
    ...commonInfoFields({
      activeType: { key: 1, name: "酒店" },
      sort,
      description: hotelTier ? `${hotelName}（${hotelTier}）` : hotelName,
      takeoffTime: { key: "N", name: "不限" },
      takeTime: 0,
      costInclude: true,
      directionWay: { key: "", name: null },
    }),
    tourDailyHotels: names.map((name) => (
      {
        ...emptyTourDailyHotel(),
        hotel: {
          hotelId: 0,
          hotelName: name,
          hotelNameEn: null,
          hotelAddress: null,
          location: null,
          brand: null,
          grade: { key: null, name: hotelTier ?? null },
          ishand: false,
        },
      }
    )),
    tourDailyPois: [emptyTourDailyPoi()],
    tourDailyDinner: emptyTourDailyDinner(null, false),
  };
}

/** 末日解散节点。结构来自 VBK 当前页面「送机/站」后 saveType=2 的真实请求。 */
export function buildDropoffInfo(args: {
  stations: ResolvedStations;
  sort: number;
}) {
  const { stations, sort } = args;
  const airportCode = stations.dropoffAir?.code ?? "";
  const airportName = stations.dropoffAir?.name ?? "";
  const trainCode = stations.dropoffTrain?.code ?? "";
  const trainName = stations.dropoffTrain?.name ?? "";
  return {
    ...commonInfoFields({
      activeType: { key: 26, name: "解散" },
      sort,
      takeoffTime: {},
      costInclude: false,
    }),
    transportation: {},
    tourDailyCar: {},
    tourDailyDinner: {},
    tourDailyImages: [],
    sightRecommend: {},
    fixedProductsOnSale: [],
    tourDailyPackageDismissList: [{
      tourDailyPackageDismissId: null,
      dismissMode: { key: 2, name: "送机/站" },
      airports: airportCode ? [{ code: airportCode, name: airportName }] : [],
      trainStations: trainCode ? [{ stationName: trainName, locationCode: trainCode }] : [],
      location: {},
      useCar: { key: "1", name: "专车" },
      serviceAllDay: true,
      pageIndex: 0,
    }],
  };
}

/**
 * 其他 / 自由活动节点：activeType=7，承载 day.description 文本。
 *  - tourDailyPois 仍带一个空 POI 占位（refId=null），避免 check 校验报错；
 *  - serviceTime 落到 startOnBoardTime / stopOnBoardTime。
 */
export function buildOtherInfo(args: {
  description: string;
  sort: number;
  serviceTime?: { startTime: string; endTime: string };
  activityTime?: string;
  durationMinutes?: number;
}) {
  const { description, sort, serviceTime } = args;
  return {
    ...commonInfoFields({
      activeType: { key: 7, name: "自由活动" },
      sort,
      description,
      takeoffTime: otherActivityTime(args.activityTime),
      takeTime: args.durationMinutes ?? 0,
      costInclude: false,
      startOnBoardTime: serviceTime?.startTime ?? "",
      stopOnBoardTime: serviceTime?.endTime ?? "",
      arriveTime: serviceTime?.startTime ?? "",
      departTime: serviceTime?.endTime ?? "",
    }),
    tourDailyPois: [emptyTourDailyPoi()],
  };
}

function otherActivityTime(value?: string): { key: string | null; name: string } {
  const time = value?.trim() || "全天";
  if (time === "不限") return { key: "N", name: "不限" };
  if (time === "全天") return { key: "D", name: "全天" };
  return { key: null, name: time };
}
