/**
 * 产品 manualReview + 顶层 productSchema：
 *   - manualReviewSchema：行程中已被人工删除的景点列表；
 *   - productSchema：sales / basicInfo / presentation / operations / commercial /
 *     manualReview / itinerary 顶层全字段校验（含 release.submitReview / publishAfterApproval
 *     默认 true）；
 *   - 顶层 .superRefine：晚数 ≤ 天数，行程条目数 == 天数。
 *
 * 顶级 schema 用 strict 模式拒绝额外字段，保持前后端契约稳定。
 */

import { z } from "zod";
import { commercialSchema } from "./commercial.js";
import { itineraryDaySchema } from "./itinerary.js";
import { operationsSchema } from "./operations.js";
import { presentationSchema } from "./presentation.js";

export const manualReviewSchema = z.object({
  itinerarySpotRemovals: z.array(z.object({
    day: z.number().int().positive(),
    name: z.string().min(1),
    removedAt: z.string().min(1),
    groupKey: z.string().min(1).optional(),
  }).strict()).default([]),
}).strict();

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
      squareGroup: z.boolean().default(false),
      maxGroupSize: z.number().int().min(2).max(50).optional(),
      guideIncluded: z.boolean().default(true),
    }),
    basicInfo: z.object({
      supplierProductName: z.string().min(2).max(400),
      // 产品壳阶段尚未写入平台；供应商产品编号在 basic 提交前即时生成。
      supplierProductCode: z.string().max(100),
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
    manualReview: manualReviewSchema.optional(),
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