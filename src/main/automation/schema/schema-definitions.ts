/**
 * 产品 JSON 完整 zod schema 定义 + 共享常量：
 *   - itineraryDaySchema / presentationSchema / bookingControlsSchema / operationsSchema /
 *     commercialSchema 等逐字段定义；
 *   - productSchema：顶层全字段校验（含 release.submitReview / publishAfterApproval 默认 false）；
 *   - HHMM_REGEX：被 ./schema-functions.ts 复用；
 *   - RECOMMENDATION_CATEGORIES：「推荐理由」分类白名单，与 VBK 下拉一致。
 *
 * 顶级 schema 用 strict 模式拒绝额外字段，保持前后端契约稳定。
 */

import { z } from "zod";
import { DEFAULT_HOTEL_TIER, HOTEL_TIER_VALUES } from "../../../shared/hotel-tiers.js";
import {
  RECOMMENDATION_CATEGORIES,
  VBK_RECOMMENDATION_CATEGORIES,
} from "../../domain/product/recommendation-categories.js";

export {
  RECOMMENDATION_CATEGORIES,
  VBK_RECOMMENDATION_CATEGORIES,
} from "../../domain/product/recommendation-categories.js";

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

export const recommendationItemSchema = z.object({
  category: z.enum(RECOMMENDATION_CATEGORIES),
  text: z.string().min(1),
});

/**
 * 产品封面信息契约（presentation.cover）：
 *   - source 必须是 ctripLibrary 或 manualUpload；
 *   - ctripLibrary：携程图库导入流程；poi / description / minQuality 必填；
 *   - manualUpload：用户手动上传；本地只存引用 + 元数据，图片二进制不进 product JSON；
 *     fileId 是 main 进程分配给本地副本的稳定 id（用于 UI / 持久化 / 之后排查）。
 *     mimeType 限制在白名单（image/jpeg / image/png / image/webp）以与 cover-storage
 *     同步；产品 JSON 仅保留引用，渲染端要预览时通过独立 IPC 拿回真实数据。
 */
export const PRODUCT_COVER_SOURCES = ["ctripLibrary", "manualUpload"] as const;
export type ProductCoverSource = (typeof PRODUCT_COVER_SOURCES)[number];

const MANUAL_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const manualUploadCoverSchema = z.object({
  source: z.literal("manualUpload"),
  fileId: z.string().min(1),
  originalName: z.string().min(1),
  mimeType: z.enum(MANUAL_UPLOAD_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
  poi: z.string().min(1),
  description: z.string().min(1),
  minQuality: z.number().min(0).max(5).default(3),
  uploadedAt: z.string().min(1),
});

const ctripLibraryCoverSchema = z.object({
  source: z.literal("ctripLibrary").default("ctripLibrary"),
  // AI 首轮允许先写 cover 语义（poi/description/minQuality），
  // imageId / imageUrl 由后续携程图库自动补全；真正“封面已完整”的判定
  // 仍由 hasCompleteCtripLibraryCover / review helper / 自动化 readback 单独把关。
  imageId: z.number().int().positive().optional(),
  imageUrl: z.string().min(1).optional(),
  // 兼容自动化：selectCtripLibraryCover 仍按 cover.poi / cover.minQuality 兜底。
  poi: z.string().min(1),
  description: z.string().min(1),
  minQuality: z.number().min(0).max(5).default(3),
  // 派生 / 审计字段：可缺省，缺省时 UI 走占位。
  thumbnailUrl: z.string().min(1).optional(),
  previewUrl: z.string().min(1).optional(),
  score: z.number().optional(),
  resolution: z.string().min(1).optional(),
  poiId: z.number().int().positive().optional(),
  poiName: z.string().min(1).optional(),
  selectedAt: z.string().min(1).optional(),
});

const presentationCoverSchema = z.discriminatedUnion("source", [
  ctripLibraryCoverSchema,
  manualUploadCoverSchema,
]);

// presentationSchema 允许 recommendation / features / recommendations 缺省：
//   - 基础信息阶段只写 productCover 时不需要先填推荐语 / 特色；
//   - 「presentation 已完成」的判定由 detectAcceptedModulesFromProduct
//     （runtime.ts）和 deepValidateModules（validation.ts）在运行时承担，
//     缺字段时它们会显式报告 missing / rejected，不会被 zod 在落库阶段
//     阻断。
//   - 保留 min(1) 校验以拒绝显式写入空字符串，但允许字段本身不存在。
const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1).optional(),
  recommendations: z.array(recommendationItemSchema).length(3).optional(),
  features: z.string().min(1).optional(),
  cover: presentationCoverSchema.optional(),
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
      userIdea: z.string().max(1000).default(""),
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
