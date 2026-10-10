/**
 * Zod schema 共用原子：
 *   - requiredText：trim 后非空字符串；
 *   - vbkSubtitle：2..40 字符（VBK 标题字段硬约束）；
 *   - VBK_RECOMMENDATION_VALUES：VBK 推荐理由下拉分类全集（9 项）字面量元组；
 *   - VBK_SELECTABLE_RECOMMENDATION_VALUES：可由 AI 选择的子集（4 项）；
 *
 * 两组都在这里导出，方便 presentation schema 同时校验"全集"与"可选子集"。
 */

import { z } from "zod";
import { VBK_RECOMMENDATION_CATEGORIES, VBK_SELECTABLE_RECOMMENDATION_CATEGORIES } from "../../domain/product/recommendation-categories.js";

export const requiredText = z.string().trim().min(1);
export const vbkSubtitle = z.string().trim().min(2).max(40, "subtitle 最多 40 个字符");
export const VBK_RECOMMENDATION_VALUES = [...VBK_RECOMMENDATION_CATEGORIES] as [string, ...string[]];
export const VBK_SELECTABLE_RECOMMENDATION_VALUES = [...VBK_SELECTABLE_RECOMMENDATION_CATEGORIES] as [string, ...string[]];