import { isProductForm } from "../../shared/product-form.js";
import type { ModuleOutcome, PlanningSkeleton, PlanningStage } from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";
import { hasValidVbkRecommendationLength } from "./vbk-recommendation-length.js";
import { ensureCommercialFallbacks, ensurePackageName } from "./commercial-stage.js";
import { ensurePresentationCover } from "./cover-default.js";
import { AI_WRITABLE_PATHS } from "./schemas.js";

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

async function ensurePresentationContent(args: {
  localProductId: string;
  runtime: OrchestratorRuntime;
}): Promise<ModuleOutcome | undefined> {
  const product = await args.runtime.loadCurrentProduct(args.localProductId);
  const presentation = record(product.presentation) ?? {};
  if (hasPresentationContent(presentation)) return undefined;
  const basic = record(product.basicInfo);
  const city = text(basic?.meetingCity) || text(basic?.destinationCity) || text(basic?.destination) || "目的地";
  const days = Number(basic?.days);
  const dayCount = Number.isInteger(days) && days > 0 ? days : 1;
  const spotNames = itinerarySpotNames(product).slice(0, 4);
  const spotText = spotNames.length ? spotNames.map(safeMarketingPlaceName).join("、") : `${city}经典景点`;
  const nextPresentation = {
    ...presentation,
    recommendationCategory: text(presentation.recommendationCategory) || "优选行程",
    recommendation: text(presentation.recommendation) || `${city}${dayCount}日私家小团，串联${spotText}，专车衔接更省心。`,
    features: text(presentation.features) || `围绕${city}代表性景点安排行程，节奏从容，适合家庭、朋友或小团队轻松出游。`,
    recommendations: validRecommendations(presentation.recommendations) ?? [
      { category: "服务保障", text: "全程专车衔接酒店与景区，避开自行换乘的繁琐，陌生路况也可安心出行" },
      { category: "精选酒店", text: "优先安排当地高品质住宿，位置与卫生双重把关，整体休息体验更舒适安心" },
      { category: "缤纷景点", text: `精选${spotText}代表性景点组合，行程兼顾人文历史与城市风光，出游体验更丰富` },
    ],
  };
  const result = await args.runtime.writeModule(args.localProductId, "presentation", AI_WRITABLE_PATHS.presentation, nextPresentation);
  if (!result.ok) return { module: "presentation", status: "rejected", reason: result.reason || "图文兜底写入失败" };
  return {
    module: "presentation",
    status: "accepted",
    writePath: AI_WRITABLE_PATHS.presentation,
    acceptedFields: ["recommendation", "features", "recommendations"],
  };
}

function safeMarketingPlaceName(value: string): string {
  return value.replace(/黑独山/g, "特色戈壁景观");
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

function itinerarySpotNames(product: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const day of Array.isArray(product.itinerary) ? product.itinerary : []) {
    const spots = record(day)?.spots;
    if (!Array.isArray(spots)) continue;
    for (const item of spots) {
      const spot = record(item);
      const name = text(spot?.poiName) || text(spot?.name);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
