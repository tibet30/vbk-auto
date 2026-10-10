/**
 * 模型端可写的 patch 路径白名单 + 对应 zod schema：
 *   - writablePatchPrefixes：模型只能写这些路径；其他一律视为禁写；
 *   - responseJsonSchema：responseTool 的 strict JSON schema；
 *   - patchOperationSchema / researchTaskSchema：单条操作 / research task 的 zod 校验；
 *   - aiResponsePayloadKeys / aiResponseSchema：顶层回复对象结构和字段集合；
 *   - patchValueSchemas：每个可写路径对应的 value 严格解析 schema；
 *   - nonEmptyText（私有）：trim 后非空字符串的内部 helper。
 */

import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);

export const writablePatchPrefixes = [
  "/sales/productType", "/sales/productForm", "/sales/splitGroup",
  "/basicInfo/supplierProductName", "/basicInfo/subtitle", "/basicInfo/days", "/basicInfo/nights", "/basicInfo/meetingCity", "/basicInfo/destinationCity", "/basicInfo/province", "/basicInfo/operationNotes",
  "/presentation",
  "/operations/transport", "/operations/pickupCity", "/operations/reusePickupForDropoff", "/operations/hotelSource", "/operations/hotelTier", "/operations/mealsIncluded", "/operations/vehicleResource/requestedTotalCost",
  "/commercial/packageName", "/commercial/terms",
  "/commercial/pricing", "/commercial/inventory", "/commercial/release",
  "/itinerary",
];

export const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "patch", "questions", "researchTasks"],
  properties: {
    reply: { type: "string", minLength: 1 },
    patch: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "path"],
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          path: { type: "string", enum: writablePatchPrefixes },
          value: {
            description: "对于 /presentation、/itinerary、/commercial/terms、/commercial/pricing、/commercial/inventory、/commercial/release 路径，value 必须是完整的嵌套对象或数组，结构详见 system prompt。对于 /sales/*、/basicInfo/*、/operations/*、/commercial/packageName 路径，value 是基本类型（string/number/boolean）。add/replace 操作必须提供 value。",
          },
        },
      },
    },
    questions: { type: "array", maxItems: 1, items: { type: "string" } },
    researchTasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "type"],
        properties: {
          label: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["vbk", "web", "cost", "image"] },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

export const patchOperationSchema = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().startsWith("/"),
  value: z.unknown().optional(),
}).strict().superRefine((operation, context) => {
  const writable = writablePatchPrefixes.includes(operation.path);
  if (!writable) context.addIssue({ code: "custom", message: `不可写入产品字段：${operation.path}` });
});

export const researchTaskSchema = z.object({ label: z.string(), type: z.enum(["vbk", "web", "cost", "image"]), detail: z.string().optional() }).strict();

export const aiResponsePayloadKeys = ["reply", "patch", "questions", "researchTasks"] as const;

export const aiResponseSchema = z.object({
  reply: nonEmptyText,
  patch: z.array(patchOperationSchema).default([]),
  questions: z.array(z.string().trim().min(1)).max(1).default([]),
  researchTasks: z.array(researchTaskSchema).default([]),
}).strict();

const pricingCostSchema = z.object({
  adult: z.number().nonnegative(),
  child: z.number().nonnegative(),
  singleSupplement: z.number().nonnegative().default(0),
  childBed: z.number().nonnegative().default(0),
}).optional();

const pricingSchema = z.object({
  currency: z.literal("CNY").default("CNY"),
  adult: z.number().positive(),
  child: z.number().nonnegative(),
  minimumTravelers: z.number().int().positive(),
  cost: pricingCostSchema,
}).superRefine((value, ctx) => {
  if (value.cost && value.cost.adult > value.adult) {
    ctx.addIssue({ code: "custom", message: "成本价不得高于售卖价" });
  }
});

const inventorySchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  dailyQuota: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if (new Date(value.startDate) > new Date(value.endDate)) {
    ctx.addIssue({ code: "custom", message: "库存开始日期不能晚于结束日期" });
  }
});

const releaseSchema = z.object({
  submitReview: z.boolean().default(true),
  publishAfterApproval: z.boolean().default(true),
  publicPriceCeiling: z.number().positive(),
  publicAuditRetries: z.number().int().min(1).max(10).default(3),
});

export const patchValueSchemas: Record<string, z.ZodType> = {
  "/sales/productType": z.enum(["domesticShort", "domesticLong"]),
  "/sales/productForm": z.enum(["groupTour", "semiSelfGuided", "privateTour", "freeTravel"]),
  "/sales/splitGroup": z.boolean(),
  "/basicInfo/supplierProductName": nonEmptyText,
  "/basicInfo/subtitle": nonEmptyText,
  "/basicInfo/days": z.number().int().min(1).max(60),
  "/basicInfo/nights": z.number().int().min(0).max(59),
  "/basicInfo/meetingCity": nonEmptyText,
  "/basicInfo/destinationCity": nonEmptyText,
  "/basicInfo/province": nonEmptyText,
  "/basicInfo/operationNotes": nonEmptyText,
  "/operations/transport": z.enum(["charter", "shared", "none"]),
  "/operations/pickupCity": nonEmptyText,
  "/operations/reusePickupForDropoff": z.boolean(),
  "/operations/hotelSource": z.literal("nonPlatform"),
  "/operations/hotelTier": z.enum(["当地3钻酒店/-3", "当地4钻酒店/-4", "当地5钻酒店/-38"]),
  "/operations/mealsIncluded": z.boolean(),
  "/commercial/packageName": nonEmptyText,
  "/commercial/terms": z.record(z.string(), nonEmptyText),
  "/commercial/pricing": pricingSchema,
  "/commercial/inventory": inventorySchema,
  "/commercial/release": releaseSchema,
};
