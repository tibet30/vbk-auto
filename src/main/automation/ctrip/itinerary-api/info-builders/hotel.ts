/**
 * 酒店节点 + 酒店档次解析：
 *   - buildHotelInfo：activeType=1（酒店），tourDailyHotels 携带一个空 hotel 占位；
 *   - hotelTierPresentation：把本地「显示名/协议枚举 key」合在一起的 hotelTier
 *     拆成 displayName + protocolKey（如 "经济/3" → { displayName: "经济", protocolKey: 3 }）。
 *
 * 真实酒店资源（hotelId / hotelAddress / location 等）由 hotelResource 阶段
 * 补全；校验响应会剥离未支持的 hotel.grade，因此这里仅写客户可见的 description。
 * 同一晚的备选酒店会渲染为"或"。
 */

import { ITINERARY_CTRIP_PLATFORM_HOTEL } from "../../../../../shared/itinerary-hotel.js";
import { HOTEL_SELECTION_NOTE } from "../../../../../shared/itinerary-service-copy.js";
import { emptyTourDailyDinner, emptyTourDailyHotel, emptyTourDailyPoi } from "../info-skeletons.js";
import { commonInfoFields } from "./common.js";

export function hotelTierPresentation(hotelTier?: string): { displayName: string | null; protocolKey: number | null } {
  const trimmed = hotelTier?.trim() ?? "";
  const matched = trimmed.match(/^(.+?)\/(-?\d+)$/);
  if (!matched) return { displayName: trimmed || null, protocolKey: null };
  return { displayName: matched[1]!.trim() || null, protocolKey: Number(matched[2]) };
}

export function buildHotelInfo(args: {
  hotelName: string;
  /** 同一晚的备选酒店；VBK 会把同一个节点内的多条记录渲染为"或"。 */
  hotelNames?: string[];
  hotelTier?: string;
  sort: number;
}) {
  const { hotelName, hotelNames, hotelTier, sort } = args;
  const names = hotelNames?.length ? hotelNames : [hotelName];
  const tier = hotelTierPresentation(hotelTier);
  return {
    ...commonInfoFields({
      activeType: { key: 1, name: "酒店" },
      sort,
      description: `${tier.displayName ? `${hotelName}（${tier.displayName}）` : hotelName}\n${HOTEL_SELECTION_NOTE}`,
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
          ishand: ITINERARY_CTRIP_PLATFORM_HOTEL.ishand,
        },
        ishand: ITINERARY_CTRIP_PLATFORM_HOTEL.ishand,
      }
    )),
    useSegmentConfig: ITINERARY_CTRIP_PLATFORM_HOTEL.useSegmentConfig,
    tourDailyPois: [emptyTourDailyPoi()],
    tourDailyDinner: emptyTourDailyDinner(null, false),
  };
}