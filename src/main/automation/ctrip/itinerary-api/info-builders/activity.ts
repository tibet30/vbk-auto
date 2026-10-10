/**
 * 集合 / 解散 / 自由活动 / 其他节点 builder：
 *   - buildPickupInfo：首日集合节点（activeType=25）；结构来自 VBK 当前页面
 *     "接机/站"后 saveType=2 的真实请求；
 *   - buildDropoffInfo：末日解散节点（activeType=26）；结构来自 VBK 当前页面
 *     "送机/站"后 saveType=2 的真实请求；
 *   - buildFreeInfo：自由活动节点（activeType=7），承载 day.description 文本；
 *     必须有正数时长才能通过正式行程审核，未指定时预留一小时；
 *   - buildOtherInfo：平台"其他"节点（activeType=9），与"自由活动"分离。
 */

import { emptyTourDailyPoi } from "../info-skeletons.js";
import type { ResolvedStations } from "../itinerary-transform.js";
import { commonInfoFields, otherActivityTime } from "./common.js";

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

export function buildFreeInfo(args: {
  description: string;
  sort: number;
  serviceTime?: { startTime: string; endTime: string };
  activityTime?: string;
  durationMinutes?: number;
}) {
  const { description, sort, serviceTime } = args;
  if (args.durationMinutes !== undefined && (!Number.isFinite(args.durationMinutes) || args.durationMinutes <= 0)) {
    throw new Error("自由活动时长必须大于0。");
  }
  return {
    ...commonInfoFields({
      activeType: { key: 7, name: "自由活动" },
      sort,
      description,
      takeoffTime: otherActivityTime(args.activityTime),
      // 自由活动必须有正数时长才能通过正式行程审核；未指定时预留一小时。
      takeTime: args.durationMinutes ?? 60,
      costInclude: false,
      startOnBoardTime: serviceTime?.startTime ?? "",
      stopOnBoardTime: serviceTime?.endTime ?? "",
      arriveTime: serviceTime?.startTime ?? "",
      departTime: serviceTime?.endTime ?? "",
    }),
    tourDailyPois: [emptyTourDailyPoi()],
  };
}

/**
 * 平台"其他"节点已通过真实请求确认使用 key=9；保持独立 builder，避免混成 key=7 的自由活动。
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
      activeType: { key: 9, name: "其他" }, sort, description,
      takeoffTime: otherActivityTime(args.activityTime), takeTime: args.durationMinutes ?? 0, costInclude: false,
      startOnBoardTime: serviceTime?.startTime ?? "", stopOnBoardTime: serviceTime?.endTime ?? "",
      arriveTime: serviceTime?.startTime ?? "", departTime: serviceTime?.endTime ?? "",
    }),
    tourDailyPois: [emptyTourDailyPoi()],
  };
}