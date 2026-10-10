/**
 * 产品 commercial 子 schema：价格 / 库存 / 条款 / 发布。
 *
 * release 段约束：
 *   - submitReview / publishAfterApproval 默认 true（"默认已是 true"语义）；
 *   - publicPriceCeiling 与 publicAuditRetries 共同决定价格天花板 / 自动审核次数。
 */

import { z } from "zod";

export const commercialSchema = z.object({
  packageName: z.string().min(1).optional(),
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