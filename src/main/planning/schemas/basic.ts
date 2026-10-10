/**
 * basicInfo / research / presentation 模块 schema：
 *   - basicInfoModuleValueSchema：subtitle (2..40) + province + 城市可选 + operationNotes；
 *   - researchTaskProposalSchema：label / type / detail（label 不能是"已确认/已解决"措辞）；
 *   - presentationModuleValueSchema：3 条互不重复 recommendations（category 命中
 *     VBK_RECOMMENDATION_VALUES 全集 9 项，text 30..84 字），加 recommendation /
 *     recommendationCategory / features / cover（可选）。
 *
 *     category 放宽到全集的原因：原 schema 收紧到 SELECTABLE (4 项) 后，
 *     "优选行程 / 缤纷景点" 分类被拒，触发误判 rejected。录入阶段按 VBK
 *     下拉 disabled 状态处理"仅展示"分类，不影响业务正确性。
 */

import { z } from "zod";
import { hasValidVbkRecommendationLength } from "../vbk-recommendation-length.js";
import { requiredText, VBK_RECOMMENDATION_VALUES, vbkSubtitle } from "./atoms.js";

export const basicInfoModuleValueSchema = z.object({
  subtitle: vbkSubtitle,
  province: requiredText,
  destinationCity: requiredText.optional(),
  meetingCity: requiredText.optional(),
  operationNotes: requiredText,
}).strict();

export const researchTaskProposalSchema = z.object({
  label: requiredText,
  type: z.enum(["vbk", "web", "cost", "image"]),
  detail: z.string().trim().optional(),
}).strict();

export const presentationModuleValueSchema = z.object({
  recommendationCategory: z.enum(VBK_RECOMMENDATION_VALUES),
  recommendation: requiredText,
  recommendations: z.array(z.object({
    category: z.enum(VBK_RECOMMENDATION_VALUES),
    text: requiredText,
  })).length(3),
  features: requiredText,
  cover: z.object({
    source: z.literal("ctripLibrary"),
    poi: requiredText,
    description: requiredText,
    minQuality: z.number().int().min(0).max(5),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.recommendations.forEach((entry, index) => {
    if (seen.has(entry.category)) {
      ctx.addIssue({ code: "custom", path: ["recommendations", index, "category"], message: "推荐理由 category 必须互不重复" });
    }
    seen.add(entry.category);
    if (!hasValidVbkRecommendationLength(entry.text)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendations", index, "text"],
        message: "推荐理由不在 30～84 个字符范围内",
      });
    }
  });
});