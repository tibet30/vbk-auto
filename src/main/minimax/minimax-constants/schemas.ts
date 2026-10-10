/**
 * 工具调用结果的 zod schema + 产品封面/cover 类 research task 的判定函数：
 *   - presentationCoverValueSchema：union(ctripLibrary.passthrough, manualUpload.strict)；
 *   - disambiguateOutcomeSchema / subtitleOutcomeSchema / advisorOutcomeSchema：
 *     模型端 result 解析 + 二次校验（顾问动作需在白名单内 / 包含中文 等）；
 *   - hasCompleteCtripLibraryCover / hasCompleteProductCover / isCoverResearchTaskSatisfiedByProduct：
 *     封面 research task 收敛判断。
 *
 * chineseText（私有）：限定长度 + 必须含中文字符的 string schema 工厂。
 */

import { z } from "zod";
import { placeholderDraftOnly, readActiveCoverFallback } from "../../../shared/cover-fallback.js";

const chineseText = (maxLength: number) => z.string().trim().min(1).max(maxLength).refine(
  (value) => /[\p{Script=Han}]/u.test(value),
  { message: "必须包含中文" },
);

export const presentationCoverValueSchema = z.union([
  // ctripLibrary：只要求 source / poi（景点 POI）；
  // imageId / imageUrl / thumbnailUrl / previewUrl / score / resolution /
  // poiId / poiName / selectedAt 是 product JSON 中已持久化的合法可选元数据
  // （来源：manual-review-field.applyProductCover 写入链路与 getImageInfo 派生字段），
  // 通过 .passthrough() 放行，避免 .strict() 把整张合法携程图库封面误判为非法，
  // 进而让 image 类 research task 一直被误标为「未满足」无法确认。
  z.object({
    source: z.literal("ctripLibrary"),
    poi: z.string().trim().min(1),
    description: z.string().optional(),
    minQuality: z.number().optional(),
  }).passthrough(),
  z.object({
    source: z.literal("manualUpload"),
    fileId: z.string().trim().min(1),
    originalName: z.string().trim().min(1),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    sizeBytes: z.number().int().positive(),
    poi: z.string().trim().min(1),
    description: z.string().trim().min(1),
    minQuality: z.number().int().min(0).max(5),
    uploadedAt: z.string().trim().min(1),
    remoteImageId: z.number().int().positive().optional(),
  }).strict(),
]);

export const disambiguateOutcomeSchema = z.object({
  pickedText: z.string(),
  // 兼容旧版本返回；缺失时由调用方按 0 处理，绝不用于新的自动采用。
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().trim().min(1).max(200),
}).strict();

export const subtitleOutcomeSchema = z.object({
  subtitle: z.string().trim().min(2).max(80),
}).strict();

export const advisorOutcomeSchema = z.object({
  summary: chineseText(80),
  rootCause: chineseText(200),
  action: z.enum([
    "retry_same_phase",
    "reload_and_retry_phase",
    "reopen_editor_and_retry_phase",
    "wait_for_user",
  ]),
  expectedEvidence: chineseText(120),
  userInstruction: z.string().optional(),
}).strict().superRefine((outcome, context) => {
  if (outcome.action !== "wait_for_user") return;
  const instruction = outcome.userInstruction?.trim() ?? "";
  if (!instruction || instruction.length > 500 || !/[\p{Script=Han}]/u.test(instruction)) {
    context.addIssue({ code: "custom", path: ["userInstruction"], message: "wait_for_user 必须提供不超过 500 字的中文 userInstruction" });
  }
});

/**
 * 判断产品 JSON 中 /presentation/cover 是否已经是一个完整的封面配置：
 *  - ctripLibrary：含 source/poi（景点 POI）即可；
 *  - manualUpload：含 fileId/originalName/mimeType/sizeBytes/poi/description/minQuality/uploadedAt 全部字段。
 * 用于「封面图研究任务是否可被当前 product 直接满足」等收敛判断。
 */
export function hasCompleteCtripLibraryCover(product: Record<string, unknown>): boolean {
  const presentation = product.presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return false;
  const cover = (presentation as Record<string, unknown>).cover;
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) return false;
  return presentationCoverValueSchema.safeParse(cover).success;
}

/**
 * 与 hasCompleteCtripLibraryCover 同义；保留语义清晰的别名以免上层误读。
 * 任何 source（ctripLibrary / manualUpload）配置完整均视为满足。
 */
export function hasCompleteProductCover(product: Record<string, unknown>): boolean {
  return hasCompleteCtripLibraryCover(product);
}

/**
 * 判断一条 image 类型的 research task 能否被当前产品 JSON 直接满足：
 * 仅当 task.type === "image" 且产品封面已经是完整封面配置时返回 true，
 * 其余情形（含 vbk/web/cost 类型任务）一律返回 false。
 */
export function isCoverResearchTaskSatisfiedByProduct(
  task: { type: string; label?: string; detail?: string },
  product: Record<string, unknown>,
): boolean {
  if (task.type !== "image") return false;
  if (readActiveCoverFallback(product) && placeholderDraftOnly(product)) return true;
  return hasCompleteCtripLibraryCover(product);
}
