/**
 * VBK tourDailyInfo 各字段的「空占位」工厂：
 *   - 抓真实 detail.json 还原出的字段结构（POI / Hotel / Flight / Train /
 *     Theme / Car / Dinner / Gather / Dismiss）逐一落在这里；
 *   - 业务写入时不需要关心字段顺序、不需要写 null / 空对象字面量。
 *
 * 关于 refId：真实样本（/tmp/tour-detail-*.json 与 Tour Helper）里 refId
 * 均是 null；前端填任何字符串都可能让后端去重校验误判。本模块所有空占位
 * 直接把 refId 写为 null，避免伪造；builders 也不再拼接 refId 字符串。
 *
 * 不臆造枚举：dinnerType / directFlightFlag / gatherMode 等所有 key 值都
 * 来自真实 detail 抓回的控制台请求。
 *
 * 出现过的 activeType.id：0 餐饮 / 1 酒店 / 2 航班 / 3 景点 / 7 自由活动
 *   / 8 交通 / 12 主题活动 / 15 用车。
 */

const DINNER_NAME: Record<"B" | "L" | "S" | "T" | "M", string> = {
  B: "早餐",
  L: "午餐",
  S: "晚餐",
  T: "夜宵",
  M: "正餐",
};

/**
 * 景点 POI 最小形状（基于真实 detail 抓回的 Old Town of Lijiang 还原）。
 *   - 业务只需要 poiId / poiName / relateSystemTicket，其它字段由 VBK 后端补全；
 *   - basicTypes / district / tags 等保留空壳以避免某些 check 校验失败。
 */
export function emptyPoiSkeleton() {
  return {
    poiId: 0,
    poiName: null,
    isPublished: null,
    poiType: { key: null, name: null },
    district: null,
    location: null,
    openTime: null,
    address: null,
    minTakeTime: 0,
    maxTakeTime: 0,
    cost: null,
    currency: { currencyCode: null },
    costUnit: { key: 1, name: "人" },
    redPoi: false,
    mapType: null,
    longitude: null,
    latitude: null,
    ggLongitude: null,
    ggLatitude: null,
    inMainLand: null,
    tags: [],
    inShoppingBlacklist: null,
    inShoppingWhitelist: null,
    childPoiIds: null,
    parentPoiIds: null,
    invaildInfoDto: {
      poiId: null,
      poiName: null,
      poiStatus: null,
      mergeToPoiId: null,
      mergeToPoiName: null,
      poiTempStartDate: null,
      poiTempEndDate: null,
    },
    openTimeDetailDto: {
      hasFormatTime: null,
      openStatus: null,
      formatTimeDtos: null,
    },
    parentTags: [],
    poiLocation: null,
    sightZones: [],
    ticketType: null,
    relateSystemTicket: { key: "F", name: "否" },
  };
}

/**
 * tourDailyPois 单元素（接送 / 餐饮 / 其他 节点都会带一个空 POI 占位）。
 * refId 为 null，对齐真实 detail 样本。
 */
export function emptyTourDailyPoi() {
  return {
    tourDailyPoiId: null,
    poi: emptyPoiSkeleton(),
    sort: 1,
    orFlag: true,
    suffixName: { key: null, name: null },
    costInclude: { key: "", name: null },
    images: [],
    refId: null,
    parentId: null,
    poiSelfFundedActivities: [],
    groupType: { key: null, name: null },
    groupSort: null,
  };
}

/**
 * tourDailyHotels 单元素占位（酒店节点会用到）。
 */
export function emptyTourDailyHotel() {
  return {
    tourDailyHotelId: null,
    sort: 1,
    hotel: {
      hotelId: 0,
      hotelName: null,
      hotelNameEn: null,
      hotelAddress: null,
      location: null,
      brand: null,
      grade: { key: null, name: null },
      ishand: false,
    },
    room: null,
    images: [],
    ishand: false,
    refId: null,
    parentId: null,
  };
}

/**
 * tourDailyFlight 单元素占位（航班节点，activeType=2）。
 */
export function emptyTourDailyFlight() {
  return {
    tourDailyFlightId: null,
    sort: 1,
    flight: {
      flightNo: null,
      directFlightFlag: { key: "D", name: "待定" },
      flightType: null,
      departureTime: null,
      departureAirport: { code: null, name: null },
      departureTerminal: null,
      arriveTime: null,
      arriveAirport: { code: null, name: null },
      arriveTerminal: null,
      stopTime: 0,
      arrivalDateOffset: 0,
      duration: 0,
      departureCityCode: null,
      arriveCityCode: null,
    },
    ishand: false,
    refId: null,
    parentId: null,
  };
}

/**
 * tourDailyTrain 单元素占位（火车节点，由接送站节点复用）。
 */
export function emptyTourDailyTrain() {
  return {
    tourDailyTrainId: null,
    sort: 1,
    train: {
      trainNo: null,
      trainType: null,
      departureStation: null,
      arriveStation: null,
      departureTime: null,
      arriveTime: null,
      seatClass: null,
    },
    ishand: false,
    refId: null,
    parentId: null,
  };
}

/**
 * tourDailyTheme 单元素占位（主题活动节点，activeType=12）。
 */
export function emptyTourDailyTheme() {
  return {
    tourDailyThemeId: null,
    sort: 1,
    theme: { key: null, name: null },
    activityName: null,
    location: null,
    images: [],
    themeFields: [],
    poiId: 0,
    includeField: { key: "F", name: "否" },
    refId: null,
    parentId: null,
    tourDailyFeatures: [],
  };
}

/**
 * tourDailyCar（transport / 用车 节点）字段；接送站节点写入 airport / trainStation。
 */
export function emptyTourDailyCar() {
  return {
    businessType: null,
    departureLocation: null,
    destinationLocation: null,
    airport: null,
    trainStation: null,
    pickUpLocation: null,
    dropOffLocation: null,
    cars: null,
  };
}

/**
 * tourDailyDinner（餐饮节点）。dinnerType key 必须命中模板枚举 B/L/S/T/M。
 *   - includedAdult: true → 费用包含（I），false → 费用自理（E）。
 */
export function emptyTourDailyDinner(
  dinnerTypeKey: "B" | "L" | "S" | "T" | "M" | null,
  includedAdult: boolean,
) {
  return {
    tourDailyDinnerId: null,
    dinnerType: dinnerTypeKey ? { key: dinnerTypeKey, name: DINNER_NAME[dinnerTypeKey] } : null,
    includeAdult: { key: includedAdult ? "I" : "E", name: includedAdult ? "费用包含" : "费用自理" },
    includeChild: { key: "E", name: "费用自理" },
    costInclude: { key: "", name: null },
    cost: 0,
    currency: { currencyCode: "CNY" },
    foodType: { key: null, name: null },
    refId: null,
    parentId: null,
  };
}

/**
 * tourDailyGather（接送节点使用）。gatherMode key 必须命中模板枚举 AIR/TRAIN。
 */
export function emptyTourDailyGather() {
  return {
    gatherMode: { key: null, name: null },
    pickUpRange: null,
    overRangeType: { key: null, name: null },
    overRangeDesc: null,
  };
}

/**
 * tourDailyDismiss（送机站使用）。dismissMode key 必须命中模板枚举 AIR/TRAIN。
 */
export function emptyTourDailyDismiss() {
  return {
    dismissMode: { key: null, name: null },
    sendBackRange: null,
    rangeTemplateId: null,
    overRangeType: { key: null, name: null },
    overRangeDesc: null,
  };
}

export const DINNER_NAME_MAP = DINNER_NAME;
