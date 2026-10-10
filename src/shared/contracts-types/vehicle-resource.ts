/**
 * 用车 + 酒店资源匹配结果：
 *   - VehicleResourceMatch：把 query + 城市 + 天数映射到携程 / VBK 资源组 ID；
 *   - HotelResourceMatch：来源 + 资源名 + 候选日落点；
 *   - CtripHotelCandidate / DayMatch：行程住宿候选与每日匹配。
 */

import type { CtripLibraryCoverAlternate } from "../contracts-ctrip-cover.js";

export interface VehicleResourceMatch {
  query: string;
  city: string;
  days: number;
  totalCost?: number;
  resourceGroupId: number;
  resourceGroupName: string;
}

export interface CtripHotelCandidate {
  hotelId: number;
  hotelName: string;
  diamond: number;
  score: number;
  distanceKm: number;
  address?: string;
  cityName: string;
  anchorName: string;
  anchorCityId: number;
  ratingType?: "diamond" | "star" | "homestay";
}

export interface CtripHotelResourceDayMatch {
  day: number;
  candidates: CtripHotelCandidate[];
}

export interface HotelResourceMatch {
  source: "vbk" | "ctrip" | "nonPlatform";
  resourceId?: number;
  resourceName: string;
  supplierCode?: string;
  roomType?: string;
  query?: string;
  dailyCandidates?: CtripHotelResourceDayMatch[];
}

/** 占位 re-export，确保上游"接过来"即可拿到 CtripLibraryCoverAlternate 形状。 */
export type { CtripLibraryCoverAlternate };