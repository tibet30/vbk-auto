/**
 * Planning 阶段的请求形状：
 *   - 景点候选生成（spotRecommendation）：用目的地 + 已排除名 + 用户意图拉一批候选；
 *   - 行程组合（verifyItinerary）：把已确认的候选整合成多日行程草稿；
 *   - 地点解析（location）：把省份 + 目的地映射成后台需要的细颗粒城市。
 */

import type { PlanningPoiCandidate } from "./poi.js";
import type { PlanningUserIntent } from "../contracts-planning-intent.js";

export interface PlanningSpotRecommendationRequest {
  destination: string;
  province: string;
  city: string;
  days: number;
  targetCount: number;
  excludedNames: string[];
  rejectedNames: string[];
  userIdea?: string;
  userIntent?: PlanningUserIntent;
}

export interface PlanningItineraryRequest {
  destination: string;
  days: number;
  candidates: Array<Required<Pick<PlanningPoiCandidate, "poiId" | "poiName">> &
    Pick<PlanningPoiCandidate, "province" | "city" | "district" | "address">>;
  previousError?: string;
  userIdea?: string;
  userIntent?: PlanningUserIntent;
}

export interface PlanningItineraryDayDraft {
  day: number;
  title: string;
  description: string;
  poiIds: number[];
  meals: string;
  mealDescriptions?: [string, string, string];
}

export interface PlanningLocationRequest {
  destination: string;
  currentProvince?: string;
  currentDestinationCity?: string;
  previousError?: string;
}

export interface PlanningLocation {
  province: string;
  destinationCity: string;
}