import { isProductForm } from "../../shared/product-form.js";
import type { ModuleOutcome, PlanningSkeleton, PlanningStage } from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";
import { hasValidVbkRecommendationLength } from "./vbk-recommendation-length.js";
import { ensureCommercialFallbacks, ensurePackageName } from "./commercial-stage.js";
import { ensurePresentationCover } from "./cover-default.js";

export function skeletonFromProduct(product: Record<string, unknown>): PlanningSkeleton {
  const basic = record(product.basicInfo);
  const sales = record(product.sales);
  const days = Number(basic?.days);
  const safeDays = Number.isInteger(days) && days > 0 ? days : 1;
  return {
    destination: String(basic?.meetingCity || basic?.destinationCity || ""),
    days: safeDays,
    nights: Number.isInteger(Number(basic?.nights)) ? Number(basic?.nights) : Math.max(0, safeDays - 1),
    productForm: isProductForm(sales?.productForm) ? sales.productForm : "privateTour",
    productType: sales?.productType === "domesticLong" ? "domesticLong" : "domesticShort",
    supplierProductCode: String(basic?.supplierProductCode ?? ""),
  };
}

export async function applyStageDeterministicCompletion(args: {
  stage: PlanningStage;
  localProductId: string;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
}): Promise<{ accepted: ModuleOutcome[]; rejected: ModuleOutcome[] }> {
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  if (args.stage === "presentation") {
    const content = await ensurePresentationContent({ localProductId: args.localProductId, runtime: args.runtime });
    if (content?.status === "accepted") accepted.push(content);
    if (content?.status === "rejected") rejected.push(content);
    const cover = await ensurePresentationCover({ localProductId: args.localProductId, runtime: args.runtime });
    if (cover?.status === "accepted") accepted.push(cover);
    if (cover?.status === "rejected") rejected.push(cover);
  }
  if (args.stage !== "commercial") return { accepted, rejected };

  const packageName = await ensurePackageName({
    state: {
      localProductId: args.localProductId,
      currentStage: "commercial",
      completedStages: [],
      stages: [],
      status: "running",
      resumeAt: new Date().toISOString(),
    },
    skeleton: args.skeleton,
    runtime: args.runtime,
  });
  if (!packageName.ok) {
    rejected.push({ module: "packageName", status: "rejected", reason: packageName.reason });
    return { accepted, rejected };
  }
  if (packageName.outcome) accepted.push(packageName.outcome);

  const fallbacks = await ensureCommercialFallbacks({
    localProductId: args.localProductId,
    skeleton: args.skeleton,
    runtime: args.runtime,
  });
  accepted.push(...fallbacks.accepted);
  rejected.push(...fallbacks.rejected);
  return { accepted, rejected };
}

/**
 * 图文内容缺失或不合格时不再本地兜底生成：保留缺口并返回拒绝原因，
 * 由阶段重试把原因回传给模型；重试用尽后进入 needs_user 标红。
 */
async function ensurePresentationContent(args: {
  localProductId: string;
  runtime: OrchestratorRuntime;
}): Promise<ModuleOutcome | undefined> {
  const product = await args.runtime.loadCurrentProduct(args.localProductId);
  const presentation = record(product.presentation) ?? {};
  if (hasPresentationContent(presentation)) return undefined;
  const missing = [
    text(presentation.recommendation) ? "" : "recommendation",
    text(presentation.features) ? "" : "features",
    validRecommendations(presentation.recommendations) ? "" : "recommendations",
  ].filter(Boolean);
  return { module: "presentation", status: "rejected", reason: `图文内容未通过校验（${missing.join("、")}），需重新生成，不使用本地兜底文案` };
}

function hasPresentationContent(presentation: Record<string, unknown>): boolean {
  return Boolean(text(presentation.recommendation) && text(presentation.features) && validRecommendations(presentation.recommendations));
}

function validRecommendations(value: unknown): Array<{ category: string; text: string }> | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const seen = new Set<string>();
  const rows: Array<{ category: string; text: string }> = [];
  for (const item of value) {
    const row = record(item);
    const category = text(row?.category);
    const content = text(row?.text);
    if (!category || !content || seen.has(category)) return undefined;
    if (!hasValidVbkRecommendationLength(content)) return undefined;
    seen.add(category);
    rows.push({ category, text: content });
  }
  return rows;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
