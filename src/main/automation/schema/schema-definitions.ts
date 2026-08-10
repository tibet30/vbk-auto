/**
 * 产品 JSON 完整 zod schema 定义 + 共享常量：
 *   - itineraryDaySchema / presentationSchema / bookingControlsSchema / operationsSchema /
 *     commercialSchema 等逐字段定义；
 *   - productSchema：顶层全字段校验（含 release.submitReview / publishAfterApproval 默认 false）；
 *   - HHMM_REGEX：被 ./schema-functions.ts 复用；
 *   - RECOMMENDATION_CATEGORIES：「推荐理由」分类白名单，共 15 项。
 *
 * 顶级 schema 用 strict 模式拒绝额外字段，保持前后端契约稳定。
 */

import { z } from "zod";
import { HOTEL_TIER_VALUES } from "../../../shared/hotel-tiers.js";

const itineraryDaySchema = z.object({
  day: z.number().int().positive(),
  title: z.string().min(1),
  spots: z.array(z.object({ name: z.string().min(1), poiName: z.string().nullable().optional(), poiId: z.number().int().positive().nullable().optional() }).strict()).default([]),
  description: z.string().default(""),
  hotel: z.string().default(""),
  meals: z.string().default(""),
  mealDescriptions: z.array(z.string().min(1)).length(3).optional(),
  hotelDescription: z.string().default(""),
  activities: z.array(z.object({
    time: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().min(1),
    type: z.enum(["transport", "visit", "meal", "hotel", "free", "other"]).default("other"),
  })).optional(),
});

// VBK 后台「推荐理由」分类白名单，共 15 项，顺序与 VBK 下拉一致。
export const RECOMMENDATION_CATEGORIES = [
  "优选行程",
  "服务保障",
  "贴心赠送",
  "精选酒店",
  "缤纷景点",
  "特色美食",
  "度假首选",
  "超值赠送",
  "五星精选",
  "限时秒杀",
  "尊享入住",
  "大牌驾到",
  "优质交通",
  "优良资质",
  "缤纷体验",
] as const;

export const recommendationItemSchema = z.object({
  category: z.enum(RECOMMENDATION_CATEGORIES),
  text: z.string().min(1),
});

const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1),
  recommendations: z.array(recommendationItemSchema).length(3).optional(),
  features: z.string().min(1),
  cover: z
    .object({
      source: z.literal("ctripLibrary").default("ctripLibrary"),
      poi: z.string().min(1),
      description: z.string().min(1),
      minQuality: z.number().min(0).max(5).default(3),
    })
    .optional(),
});

// 自动录入 VBK 基本信息时，除了产品元数据还会用到两类运营数据：
//   - 提前预订：确定性运营规则（默认提前 1 天、12:00 截止），可配置覆盖。
//   - 管家联系人：账号级固定信息，自动化按 stable contactCardId 选择。
// AI 不能生成这两项；管家联系人只能由账号固定信息在创建时注入，或由人工
// review field 写入。地接社名称不属于账号固定信息，由自动化在 VBK 当前页
// 下拉里自动选择第一个可用且非 disabled 的选项；缺失时直接报错。
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

const operationsSchema = z.object({
  transport: z.enum(["charter", "shared", "none"]).default("charter"),
  pickupCity: z.string().min(1),
  reusePickupForDropoff: z.boolean().default(true),
  hotelSource: z.literal("nonPlatform").default("nonPlatform"),
  hotelTier: z
    .enum(HOTEL_TIER_VALUES)
    .default("当地3钻酒店/-3"),
  mealsIncluded: z.boolean().default(false),
  // 自动化基本信息的运营控件；可缺省，按默认值填入。
  bookingControls: bookingControlsSchema.optional(),
  vehicleResource: z
    .object({
      resourceGroupId: z.number().int().positive().optional(),
      resourceGroupName: z.string().min(1).optional(),
      requestedDailyCost: z.number().positive().optional(),
      serviceHoursPerDay: z.number().int().min(4).max(24).optional(),
      serviceKilometersPerDay: z.number().int().min(50).max(1000).optional(),
    })
    .optional(),
  hotelResource: z
    .object({
      source: z.enum(["vbk", "nonPlatform"]),
      resourceId: z.number().int().positive().optional(),
      resourceName: z.string().min(1),
      supplierCode: z.string().min(1).optional(),
      roomType: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      hotelTier: z.enum(HOTEL_TIER_VALUES).optional(),
      diamond: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
    })
    .optional(),
});

const commercialSchema = z.object({
  packageName: z.string().min(1),
  pricing: z.object({
    currency: z.literal("CNY").default("CNY"),
    adult: z.number().positive(),
    child: z.number().nonnegative(),
    minimumTravelers: z.number().int().positive(),
    cost: z
      .object({
        adult: z.number().nonnegative(),
        child: z.number().nonnegative(),
        singleSupplement: z.number().nonnegative().default(0),
        childBed: z.number().nonnegative().default(0),
      })
      .optional(),
  }).optional(),
  inventory: z.object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dailyQuota: z.number().int().positive(),
  }).optional(),
  terms: z.object({
    inclusions: z.string().min(1).optional(),
    exclusions: z.string().min(1).optional(),
    bookingNotes: z.string().min(1).optional(),
    refundPolicy: z.string().min(1).optional(),
    cancellationPolicy: z.string().min(1).optional(),
    changePolicy: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  }).optional(),
  release: z.object({
    submitReview: z.boolean().default(true),
    publishAfterApproval: z.boolean().default(true),
    publicPriceCeiling: z.number().positive(),
    publicAuditRetries: z.number().int().min(1).max(10).default(3),
  }).optional(),
});

export const productSchema = z
  .object({
    sales: z.object({
      productType: z.enum(["domesticShort", "domesticLong"]),
      productForm: z.enum([
        "groupTour",
        "semiSelfGuided",
        "privateTour",
        "freeTravel",
      ]),
      splitGroup: z.boolean().default(false),
    }),
    basicInfo: z.object({
      supplierProductName: z.string().min(2).max(400),
      supplierProductCode: z.string().min(1).max(100),
      subtitle: z.string().min(2).max(80),
      days: z.number().int().min(1).max(60),
      nights: z.number().int().min(0).max(59),
      meetingCity: z.string().min(1),
      destinationCity: z.string().min(1),
      province: z.string().min(1),
      operationNotes: z.string().min(1),
    }),
    presentation: presentationSchema.optional(),
    operations: operationsSchema.optional(),
    commercial: commercialSchema.optional(),
    itinerary: z.array(itineraryDaySchema).min(1),
  })
  .superRefine((product, ctx) => {
    if (product.basicInfo.nights > product.basicInfo.days) {
      ctx.addIssue({
        code: "custom",
        path: ["basicInfo", "nights"],
        message: "晚数不能大于天数",
      });
    }
    if (product.itinerary.length !== product.basicInfo.days) {
      ctx.addIssue({
        code: "custom",
        path: ["itinerary"],
        message: "行程条目数必须与行程天数一致",
      });
    }
  });
