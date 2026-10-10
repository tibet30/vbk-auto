/**
 * 防御深度闸门：
 *   - assertPresentationReadyForVbk：fillAndSavePresentation 进入 VBK 写入前再校验一次。
 *     即便 readiness 通过、AI 已写、商业逻辑错误等导致产品被改动，
 *     VBK 阶段自身仍能在第一行就抛错。
 *
 * 配套测试：test/automation/automation-contract.test.ts G3：
 *   - assertPresentationReadyForVbk 会在 VBK 写入前就抛错。
 */

import { readCover } from "../../operations/cover-info.js";
import { isCtripLibraryCoverComplete } from "../../operations/cover-auto-fill.js";
import { manualUploadCoverSchema } from "../schema/schema-definitions.js";
import { placeholderDraftOnly, readActiveCoverFallback } from "../../../shared/cover-fallback.js";
import {
  asObject,
  hasValidPresentationRecommendations,
  textValue,
} from "../automation-contract.helpers.js";

export function assertPresentationReadyForVbk(product: Record<string, unknown>): void {
  const fallback = readActiveCoverFallback(product);
  if (fallback && !placeholderDraftOnly(product)) {
    throw new Error("运营占位图只能录入未提审、未上架的 VBK 草稿；请先关闭发布控制。");
  }
  const presentation = asObject(product.presentation);
  if (!presentation) {
    throw new Error("产品图文（presentation）尚未生成，请先在 AI 规划阶段补全推荐语、产品特点、推荐理由。");
  }
  if (textValue(presentation.recommendation).length === 0) {
    throw new Error("产品图文缺少推荐语，请先在 AI 规划阶段补全 presentation.recommendation。");
  }
  if (textValue(presentation.features).length === 0) {
    throw new Error("产品图文缺少产品特点，请先在 AI 规划阶段补全 presentation.features。");
  }
  if (!hasValidPresentationRecommendations(product)) {
    throw new Error("推荐理由必须恰好 3 条：分类在白名单且不重复，文本非空。请补全 presentation.recommendations。");
  }
  const cover = readCover(product);
  if (!cover && !fallback) {
    throw new Error("产品图文缺少封面图，请先在 AI 规划阶段从携程图库选定一张图片。");
  }
  if (cover?.source === "manualUpload" && !fallback) {
    const rawCover = asObject(presentation.cover);
    if (!rawCover || !manualUploadCoverSchema.safeParse(rawCover).success) {
      throw new Error("手动上传封面元数据不完整，请重新保存封面。");
    }
  }
  if (cover?.source === "ctripLibrary" && !fallback) {
    const rawCover = asObject(presentation.cover);
    if (!isCtripLibraryCoverComplete(rawCover)) {
      throw new Error("产品图文封面尚未选定具体图片，请先持久化携程图库的 imageId 与 imageUrl。");
    }
  }
}