// @ts-nocheck
import { z } from "zod";

const itineraryDaySchema = z.object({
  day: z.number().int().positive(),
  title: z.string().min(1),
  spots: z.array(z.string().min(1)).default([]),
  description: z.string().default(""),
  hotel: z.string().default(""),
  meals: z.string().default(""),
  mealDescriptions: z.array(z.string().min(1)).length(3).optional(),
  hotelDescription: z.string().default(""),
});

const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1),
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

const operationsSchema = z.object({
  transport: z.enum(["charter", "shared", "none"]).default("charter"),
  pickupCity: z.string().min(1),
  reusePickupForDropoff: z.boolean().default(true),
  hotelSource: z.literal("nonPlatform").default("nonPlatform"),
  hotelTier: z
    .enum([
      "当地2钻酒店/-2",
      "当地3钻酒店/-3",
      "当地4钻酒店/-4",
      "当地5钻酒店/-5",
    ])
    .default("当地3钻酒店/-3"),
  mealsIncluded: z.boolean().default(false),
  vehicleResource: z
    .object({
      vehicleId: z.number().int().positive(),
      resourceId: z.number().int().positive().optional(),
      resourceGroupId: z.number().int().positive(),
      resourceGroupName: z.string().min(1),
      resourceGroupMaxItemPrice: z.number().positive().default(1000),
      vehicleModel: z.string().min(1),
      resourceName: z.string().min(1),
      supplierCode: z.string().min(1),
      serviceHoursPerDay: z.number().int().min(4).max(24).default(10),
      serviceKilometersPerDay: z.number().int().min(50).max(1000).default(300),
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
  }),
  inventory: z.object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dailyQuota: z.number().int().positive(),
  }),
  terms: z.object({
    inclusions: z.string().min(20),
    exclusions: z.string().min(20),
    bookingNotes: z.string().min(20),
    refundPolicy: z.string().min(20),
  }),
  release: z.object({
    submitReview: z.boolean().default(true),
    publishAfterApproval: z.boolean().default(true),
    publicPriceCeiling: z.number().positive(),
    publicAuditRetries: z.number().int().min(1).max(10).default(3),
  }),
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

export function parseProduct(input) {
  return productSchema.parse(input);
}
