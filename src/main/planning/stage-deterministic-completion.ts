import { isProductForm } from "../../shared/product-form.js";
import type { ModuleOutcome, PlanningSkeleton, PlanningStage } from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
