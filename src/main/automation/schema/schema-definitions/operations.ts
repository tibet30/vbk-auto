/**
 * 产品 operations 子 schema：
 *   - advanceBookingSchema / bookingControlsSchema：提前预订与管家联系人；
 *   - trafficLineStationSchema / trafficLineEndpointPairSchema /
 *     trafficLineAvailabilitySchema / trafficLineConfigSchema：大交通只读配置；
 *   - operationsSchema：运营总览（车型 / 接送 / 酒店 / 餐 / vehicleResource / hotelResource）；
 *
 * 自动录入 VBK 基本信息时，除了产品元数据还会用到两类运营数据：
 *   - 提前预订：确定性运营规则（默认提前 1 天、12:00 截止），可配置覆盖。
 *   - 管家联系人：账号级固定信息，自动化按 stable contactCardId 选择。
 * AI 不能生成这两项；管家联系人只能由账号固定信息在创建时注入，或由人工
 * review field 写入。地接社名称不属于账号固定信息，由自动化在 VBK 当前页
 * 下拉里自动选择第一个可用且非 disabled 的选项；缺失时直接报错。
 *
 * 当前 VBK 会话的只读端点核验事实：
 *   - 它用于审查区展示"哪些交通方式已筛选确认、可在下一步录入"，不是
 *     trafficLine 子产品已经创建或激活的证明。
 *   - 该对象由受控端点查询写入，因此必须纳入严格产品 schema，不能被 readiness 误报为未知字段。
 */

import { z } from "zod";
import {
  DEFAULT_HOTEL_TIER,
  HOTEL_TIER_VALUES,
} from "../../../../shared/hotel-tiers.js";
import {
  HOTEL_RESOURCE_CANDIDATE_COUNT,
  HOTEL_RESOURCE_MIN_CANDIDATE_COUNT,
} from "../../../../shared/hotel-candidate-counts.js";
import {
  DEFAULT_TRAFFIC_LINE_CONFIG,
  TRAFFIC_LINE_VARIANTS,
} from "../../../../shared/contracts-traffic-line.js";

export const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const advanceBookingSchema = z.object({
  days: z.number().int().nonnegative(),
  time: z.string().regex(HHMM_REGEX, "时间格式必须为 HH:mm"),
});

const bookingControlsSchema = z.object({
  advanceBooking: advanceBookingSchema.optional(),
  // 管家联系人复用 AccountFixedInfo 的 ContactCardSelection 结构（保持 ID 稳定）。
  // 地接社不再写入产品 JSON；VBK 下拉里选第一个可用且非 disabled 的项。
  butler: z
    .object({
      contactCardId: z.number().int().positive(),
      displayName: z.string().min(1),
      providerId: z.number().int().positive(),
    })
    .optional(),
});

const trafficLineStationSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  resourceKey: z.string().trim().min(1).optional(),
}).strict();

const trafficLineEndpointPairSchema = z.object({
  arrival: trafficLineStationSchema,
  departure: trafficLineStationSchema,
}).strict();

const trafficLineAvailabilitySchema = z.object({
  endpointPlan: z.object({
    arrivalCity: z.string().trim().min(1),
    departureCity: z.string().trim().min(1),
    resolvedAt: z.string().min(1),
    flight: trafficLineEndpointPairSchema.optional(),
    train: trafficLineEndpointPairSchema.optional(),
  }).strict(),
  availableVariants: z.array(z.enum(TRAFFIC_LINE_VARIANTS)).min(1).max(TRAFFIC_LINE_VARIANTS.length),
  unavailableVariants: z.object({
    flightRoundTrip: z.string().min(1).optional(),
    trainRoundTrip: z.string().min(1).optional(),
  }).strict(),
}).strict();

const trafficLineConfigSchema = z.object({
  // 未指定时不创建大交通子产品；接/送站属于地接行程，不等同于售卖往返票。
  enabled: z.boolean().default(DEFAULT_TRAFFIC_LINE_CONFIG.enabled),
  variants: z.array(z.enum(TRAFFIC_LINE_VARIANTS)).max(TRAFFIC_LINE_VARIANTS.length)
    .default(DEFAULT_TRAFFIC_LINE_CONFIG.variants),
  // 明确指定的端点优先于默认目的地；首末日景点不会参与端点推断。
  arrivalCity: z.string().trim().min(1).max(50).optional(),
  departureCity: z.string().trim().min(1).max(50).optional(),
  availability: trafficLineAvailabilitySchema.optional(),
}).strict();

export const operationsSchema = z.object({
  transport: z.enum(["charter", "shared", "none"]).default("charter"),
  pickupCity: z.string().min(1),
  reusePickupForDropoff: z.boolean().default(true),
  hotelSource: z.literal("nonPlatform").default("nonPlatform"),
  hotelFallbackPolicy: z.object({ allowDowngrade: z.boolean().default(true) }).strict().default({ allowDowngrade: true }),
  hotelTier: z
    .enum(HOTEL_TIER_VALUES)
    .default(DEFAULT_HOTEL_TIER),
  mealsIncluded: z.boolean().default(false),
  // 自动化基本信息的运营控件；可缺省，按默认值填入。
  bookingControls: bookingControlsSchema.optional(),
  vehicleResource: z
    .object({
      resourceGroupId: z.number().int().positive().optional(),
      resourceGroupName: z.string().min(1).optional(),
      requestedTotalCost: z.number().positive().optional(),
      serviceHoursPerDay: z.number().int().min(4).max(24).optional(),
      serviceKilometersPerDay: z.number().int().min(50).max(1000).optional(),
    })
    .optional(),
  hotelResource: z
    .object({
      source: z.enum(["vbk", "ctrip", "nonPlatform"]),
      resourceId: z.number().int().positive().optional(),
      resourceName: z.string().min(1),
      supplierCode: z.string().min(1).optional(),
      roomType: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      hotelTier: z.enum(HOTEL_TIER_VALUES).optional(),
      diamond: z.number().int().min(0).max(5).optional(),
      candidates: z.array(z.object({
        hotelId: z.number().int().positive(), hotelName: z.string().min(1), diamond: z.number().int().min(0).max(5),
        score: z.number().nonnegative(), distanceKm: z.number().nonnegative(), address: z.string().min(1).optional(),
        cityName: z.string().min(1), anchorName: z.string().min(1), anchorCityId: z.number().int().positive(),
        ratingType: z.enum(["diamond", "star", "homestay"]).optional(),
      }).strict()).min(HOTEL_RESOURCE_MIN_CANDIDATE_COUNT).max(HOTEL_RESOURCE_CANDIDATE_COUNT).optional(),
      dailyCandidates: z.array(z.object({
        day: z.number().int().positive(),
        candidates: z.array(z.object({
          hotelId: z.number().int().positive(), hotelName: z.string().min(1), diamond: z.number().int().min(0).max(5),
          score: z.number().nonnegative(), distanceKm: z.number().nonnegative(), address: z.string().min(1).optional(),
          cityName: z.string().min(1), anchorName: z.string().min(1), anchorCityId: z.number().int().positive(),
          ratingType: z.enum(["diamond", "star", "homestay"]).optional(),
        }).strict()).min(HOTEL_RESOURCE_MIN_CANDIDATE_COUNT).max(HOTEL_RESOURCE_CANDIDATE_COUNT),
      }).strict()).optional(),
    })
    .optional(),
  trafficLine: trafficLineConfigSchema.optional(),
});