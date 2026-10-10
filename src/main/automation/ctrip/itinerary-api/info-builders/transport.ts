/**
 * 平台模板交通（activeType=8）builder：
 *   - 仅要求时间、说明；不伪造班次或车辆资源；
 *   - description 来自 shared/itinerary-service-copy 的 dailyTransportDescription。
 */

import { dailyTransportDescription } from "../../../../../shared/itinerary-service-copy.js";
import { commonInfoFields } from "./common.js";

export function buildDailyTransportInfo(title: string, sort: number) {
  return commonInfoFields({ activeType: { key: 8, name: "交通" }, sort,
    takeoffTime: { key: "D", name: "全天" }, description: dailyTransportDescription(title), costInclude: true });
}