/**
 * 其他模块 schema：itinerary / pricing / inventory / terms / release /
 * packageName / operations（skeleton）。
 *   - itinerary：数组，每项用 itineraryDaySchema 校验；
 *   - pricing：成人/儿童价 + 成本（可选）+ minimumTravelers（可选）；cost.adult
 *     不可超过 adult；
 *   - inventory：YYYY-MM-DD startDate / endDate + dailyQuota；startDate <= endDate；
 *   - terms：inclusions / exclusions / bookingNotes / refundPolicy 四项必填；
 *   - release：默认值强制 draft-only（submitReview=false, publishAfterApproval=
 *     false），AI 即便传 true 也被丢弃；publicAuditRetries 1..10；
 *   - packageName：trim 后非空字符串；
 *   - operationsHotelTierUpdateSchema：skeleton 阶段允许写入的字段集合：
 *     hotelTier / pickupCity / transport / reusePickupForDropoff / mealsIncluded /
 *     vehicleResource.requestedTotalCost。
 */

import { z } from "zod";
import { HOTEL_TIER_VALUES } from "../../../shared/hotel-tiers.js";
import { itineraryDaySchema } from "../itinerary-day-schema.js";
import { requiredText } from "./atoms.js";

export const itineraryModuleValueSchema = z.array(itineraryDaySchema).min(1);

export const pricingModuleValueSchema = z.object({
  currency: z.literal("CNY").default("CNY"),
  adult: z.number().positive(),
  child: z.number().nonnegative(),
  minimumTravelers: z.number().int().positive().optional(),
  cost: z.object({
    adult: z.number().nonnegative(),
    child: z.number().nonnegative(),
    singleSupplement: z.number().nonnegative().default(0),
    childBed: z.number().nonnegative().default(0),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cost && value.cost.adult > value.adult) {
    ctx.addIssue({ code: "custom", message: "成本价不得高于售卖价" });
  }
});

export const inventoryModuleValueSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate 必须是 YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate 必须是 YYYY-MM-DD"),
  dailyQuota: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (new Date(value.startDate) > new Date(value.endDate)) {
    ctx.addIssue({ code: "custom", message: "库存开始日期不能晚于结束日期" });
  }
});

export const termsModuleValueSchema = z.object({
  inclusions: requiredText,
  exclusions: requiredText,
  bookingNotes: requiredText,
  refundPolicy: requiredText,
}).strict();

/**
 * release 模块：默认值强制 draft-only（submitReview=false, publishAfterApproval=false）。
 * AI 即便传 true 也被丢弃；只有人工/VBK 显式标记才会切换到发布态。
 */
export const releaseModuleValueSchema = z.object({
  submitReview: z.boolean().optional(),
  publishAfterApproval: z.boolean().optional(),
  publicPriceCeiling: z.number().positive(),
  publicAuditRetries: z.number().int().min(1).max(10).default(3),
}).strict();

export const packageNameModuleValueSchema = z.string().trim().min(1);

export const operationsHotelTierUpdateSchema = z.object({
  hotelTier: z.enum(HOTEL_TIER_VALUES).optional(),
  pickupCity: z.string().trim().min(1).optional(),
  transport: z.enum(["charter", "shared", "none"]).optional(),
  reusePickupForDropoff: z.boolean().optional(),
  mealsIncluded: z.boolean().optional(),
  vehicleResource: z.object({
    requestedTotalCost: z.number().positive().nullable().optional(),
  }).strict().optional(),
}).strict();