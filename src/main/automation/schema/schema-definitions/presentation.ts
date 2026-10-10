/**
 * 产品 presentation 子 schema：
 *   - manualUploadCoverSchema：用户手动上传封面；只存引用 + 元数据；
 *   - ctripLibraryCoverSchema：携程图库导入封面；
 *   - presentationCoverSchema：discriminatedUnion 派发；
 *   - recommendationItemSchema：推荐语白名单 + VBK 长度校验；
 *   - presentationSchema：顶层 presentation 字段（含 coverFallback）。
 *
 * presentationSchema 允许 recommendation / features / recommendations 缺省：
 *   - 基础信息阶段只写 productCover 时不需要先填推荐语 / 特色；
 *   - 「presentation 已完成」的判定由 detectAcceptedModulesFromProduct
 *     （runtime.ts）和 deepValidateModules（validation.ts）在运行时承担，
 *     缺字段时它们会显式报告 missing / rejected，不会被 zod 在落库阶段
 *     阻断。
 *   - 保留 min(1) 校验以拒绝显式写入空字符串，但允许字段本身不存在。
 */

import { z } from "zod";
import { RECOMMENDATION_CATEGORIES } from "../../../domain/product/recommendation-categories.js";
import { hasValidVbkRecommendationLength } from "../../../planning/vbk-recommendation-length.js";

/**
 * 产品封面信息契约（presentation.cover）：
 *   - source 必须是 ctripLibrary 或 manualUpload；
 *   - ctripLibrary：携程图库导入流程；只要求景点 poi；
 *   - manualUpload：用户手动上传；本地只存引用 + 元数据，图片二进制不进 product JSON；
 *     fileId 是 main 进程分配给本地副本的稳定 id（用于 UI / 持久化 / 之后排查）。
 *     mimeType 限制在白名单（image/jpeg / image/png / image/webp）以与 cover-storage
 *     同步；产品 JSON 仅保留引用，渲染端要预览时通过独立 IPC 拿回真实数据。
 */
export const PRODUCT_COVER_SOURCES = ["ctripLibrary", "manualUpload"] as const;
export type ProductCoverSource = (typeof PRODUCT_COVER_SOURCES)[number];

const MANUAL_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const manualUploadCoverSchema = z.object({
  source: z.literal("manualUpload"),
  fileId: z.string().min(1),
  originalName: z.string().min(1),
  mimeType: z.enum(MANUAL_UPLOAD_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
  poi: z.string().min(1),
  description: z.string().min(1),
  minQuality: z.number().min(0).max(5).default(3),
  uploadedAt: z.string().min(1),
  remoteImageId: z.number().int().positive().optional(),
});

const ctripLibraryCoverSchema = z.object({
  source: z.literal("ctripLibrary").default("ctripLibrary"),
  // AI 首轮只需给出代表景点 poi，
  // imageId / imageUrl 由后续携程图库自动补全；真正"封面已完整"的判定
  // 仍由 hasCompleteCtripLibraryCover / review helper / 自动化 readback 单独把关。
  imageId: z.number().int().positive().optional(),
  imageUrl: z.string().min(1).optional(),
  // 封面检索只按 cover.poi；其余字段是历史兼容元数据。
  poi: z.string().min(1),
  description: z.string().optional(),
  minQuality: z.number().optional(),
  // 派生 / 审计字段：可缺省，缺省时 UI 走占位。
  thumbnailUrl: z.string().min(1).optional(),
  previewUrl: z.string().min(1).optional(),
  score: z.number().optional(),
  resolution: z.string().min(1).optional(),
  poiId: z.number().int().positive().optional(),
  poiName: z.string().min(1).optional(),
  selectedAt: z.string().min(1).optional(),
  missingPoiImages: z.array(z.string().min(1)).optional(),
  alternates: z.array(z.object({
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
});

const presentationCoverSchema = z.discriminatedUnion("source", [
  ctripLibraryCoverSchema,
  manualUploadCoverSchema,
]);

export const recommendationItemSchema = z.object({
  category: z.enum(RECOMMENDATION_CATEGORIES),
  text: z.string().min(1).refine(hasValidVbkRecommendationLength, "推荐理由不在 VBK 平台 30～84 字符范围内"),
});

export const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1).optional(),
  recommendations: z.array(recommendationItemSchema).length(3).optional(),
  features: z.string().min(1).optional(),
  cover: presentationCoverSchema.optional(),
  coverFallback: z.object({
    slotKey: z.literal("presentation.cover"),
    assetKey: z.literal("cover-landscape"),
    reason: z.enum(["no_qualified_candidate", "search_unavailable"]),
    createdAt: z.string().min(1),
    remoteImageId: z.number().int().positive().optional(),
  }).optional(),
});