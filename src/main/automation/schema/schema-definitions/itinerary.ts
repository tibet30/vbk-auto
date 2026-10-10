/**
 * 产品 itinerary 子 schema：
 *   - itineraryDaySchema：行程每天的 spot / description / hotel / activities 等；
 *   - 景点 schema.superRefine：禁止「自由活动 / 其他活动」同时绑定 POI；
 *   - hotel / hotelCandidates 与 hotelResourceSchema 共享 hotel-candidate-counts 上下限；
 */

import { z } from "zod";
import {
  HOTEL_RESOURCE_CANDIDATE_COUNT,
  HOTEL_RESOURCE_MIN_CANDIDATE_COUNT,
} from "../../../../shared/hotel-candidate-counts.js";

export const itineraryDaySchema = z.object({
  day: z.number().int().positive(),
  title: z.string().min(1),
  spots: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(["attraction", "free", "other"]).default("attraction"),
    description: z.string().optional(),
    poiName: z.string().nullable().optional(),
    poiId: z.number().int().positive().nullable().optional(),
    province: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    district: z.string().nullable().optional(),
    timeOfDay: z.enum(["morning", "afternoon"]).optional(),
    relation: z.enum(["and", "or"]).optional(),
    // 录入阶段自动补齐：封面用满 10 张后剩余图按 POI 归属写入对应景点。
    // 字段结构复用 ctripLibraryCoverSchema.alternates 的子对象，保证
    // 解析时不会因为 strict() 拒绝未知字段。
    images: z.array(z.object({
      imageId: z.number().int().positive(),
      imageUrl: z.string().min(1),
      poi: z.string().min(1),
      thumbnailUrl: z.string().min(1).optional(),
      previewUrl: z.string().min(1).optional(),
      score: z.number().optional(),
      resolution: z.string().min(1).optional(),
      poiId: z.number().int().positive().optional(),
      poiName: z.string().min(1).optional(),
      selectedAt: z.string().min(1).optional(),
    }).strict()).optional(),
  }).strict().superRefine((spot, ctx) => {
    if (spot.kind !== "attraction" && (spot.poiName || spot.poiId)) ctx.addIssue({ code: "custom", message: "自由活动或其他活动不得绑定 POI" });
  })).default([]),
  description: z.string().default(""),
  hotel: z.string().default(""),
  hotelRequirement: z.object({ anchorName: z.string().min(1), cityName: z.string().min(1).optional(),
    maxDistanceKm: z.number().positive().optional(), diamond: z.number().int().min(0).max(5).optional(),
    ratingType: z.enum(["diamond", "star", "homestay"]).optional() }).strict().optional(),
  hotelCandidates: z.array(z.object({
    hotelId: z.number().int().positive(),
    hotelName: z.string().min(1),
    diamond: z.number().int().min(0).max(5),
    score: z.number().nonnegative(),
    distanceKm: z.number().nonnegative(),
    address: z.string().min(1).optional(),
    cityName: z.string().min(1),
    anchorName: z.string().min(1),
    anchorCityId: z.number().int().positive(),
    ratingType: z.enum(["diamond", "star", "homestay"]).optional(),
  }).strict()).min(HOTEL_RESOURCE_MIN_CANDIDATE_COUNT).max(HOTEL_RESOURCE_CANDIDATE_COUNT).optional(),
  meals: z.string().default(""),
  mealDescriptions: z.array(z.string().min(1)).length(3).optional(),
  hotelDescription: z.string().default(""),
  activities: z.array(z.object({
    time: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().min(1),
    type: z.enum(["transport", "visit", "meal", "hotel", "free", "other"]).default("other"),
    durationMinutes: z.number().int().positive().optional(),
    source: z.enum(["user", "ai"]).optional(),
  })).optional(),
});