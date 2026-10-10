/**
 * tourDailyInfo 共用字段工厂：
 *   - 每个 tourDailyInfo 都需要这些键，让 VBK 校验能逐字段对齐；
 *   - activeType / sort / costInclude / description / 4 个 *Package* 列表等都在这里
 *     统一构造，避免每个 builder 重复写大段字段；
 *   - 业务节点只在差异字段（POI / Hotel / Flight …）上做覆盖；
 *   - otherActivityTime：把"不限 / 全天 / HH:mm" 折成 key + name。
 *
 * refId 一律为 null（真实 detail 样本里 refId 都是 null；不允许伪造字符串）。
 */

export function commonInfoFields(args: {
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

export function otherActivityTime(value?: string): { key: string | null; name: string } {
  const time = value?.trim() || "全天";
  if (time === "不限") return { key: "N", name: "不限" };
  if (time === "全天") return { key: "D", name: "全天" };
  return { key: null, name: time };
}