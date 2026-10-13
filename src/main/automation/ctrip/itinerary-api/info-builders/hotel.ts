import { PLATFORM_HOTEL_DESCRIPTION } from "../../../../../shared/platform-hotel-rules.js";
/** One platform-hotel description node; resource segments own automatic matching rules. */

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
  /** 历史调用兼容参数；规则模式不写指定酒店名称。 */
  hotelNames?: string[];
  hotelTier?: string;
  sort: number;
}) {
  const { sort } = args;
  const names = [PLATFORM_HOTEL_DESCRIPTION];
  return {
    ...commonInfoFields({
      activeType: { key: 1, name: "酒店" },
      sort,
      description: `${PLATFORM_HOTEL_DESCRIPTION}\n${HOTEL_SELECTION_NOTE}`,
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