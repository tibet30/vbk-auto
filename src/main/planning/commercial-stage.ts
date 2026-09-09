import { AI_WRITABLE_PATHS } from "./schemas.js";
import { STAGE_ALLOWED_MODULES } from "./stage-contract.js";
import { buildPackageName } from "./package-name.js";
import { defaultCommercialInventory } from "../data/commercial-defaults.js";
import type { OrchestratorRuntime } from "./types.js";
import type {
  ModuleOutcome,
  PlanningGenerationState,
  PlanningModule,
  PlanningSkeleton,
} from "../../shared/contracts-planning.js";

export async function ensurePackageName(args: {
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
}): Promise<{ ok: true; outcome?: ModuleOutcome } | { ok: false; reason: string }> {
  const acceptedModules = await args.runtime.loadAcceptedModules(args.state.localProductId);
  if (acceptedModules.includes("packageName")) return { ok: true };
  const packageName = buildPackageName(args.skeleton);
  const writeResult = await args.runtime.writeModule(args.state.localProductId, "packageName", AI_WRITABLE_PATHS.packageName, packageName);
  if (!writeResult.ok) {
    return { ok: false, reason: writeResult.reason || "本地生成套餐名写入失败" };
  }
  return {
    ok: true,
    outcome: {
      module: "packageName",
      status: "accepted",
      writePath: AI_WRITABLE_PATHS.packageName,
      acceptedFields: ["packageName"],
    },
  };
}

/**
 * 商业阶段的本地估价兜底。
 *
 * 模型不能取得实时供应商报价时，仍需产出可审核的草稿价；这里仅基于已落库
 * 的行程规模、酒店档次、日用车形态及讲解密度计算「指导价」，不读取或猜测
 * VBK 资源组标价。真实采购价仍需在发布前按出行日复核。
 */
export async function ensureCommercialFallbacks(args: {
  localProductId: string;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
}): Promise<{ accepted: ModuleOutcome[]; rejected: ModuleOutcome[] }> {
  const product = await args.runtime.loadCurrentProduct(args.localProductId);
  const commercial = record(product.commercial);
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];

  let adultPrice = positiveNumber(record(commercial?.pricing)?.adult);
  if (!hasPricing(commercial?.pricing)) {
    const pricing = estimateCommercialPricing(args.skeleton, product);
    const outcome = await writeFallback(args, "pricing", pricing, ["currency", "adult", "child", "minimumTravelers", "cost"]);
    (outcome.status === "accepted" ? accepted : rejected).push(outcome);
    adultPrice = pricing.adult;
  }

  if (!hasInventory(commercial?.inventory)) {
    const outcome = await writeFallback(args, "inventory", defaultCommercialInventory(), ["startDate", "endDate", "dailyQuota"]);
    (outcome.status === "accepted" ? accepted : rejected).push(outcome);
  }

  if (!hasRelease(commercial?.release, adultPrice) && adultPrice) {
    const outcome = await writeFallback(args, "release", {
      submitReview: false,
      publishAfterApproval: false,
      publicPriceCeiling: ceilToTen(adultPrice * 1.3),
      publicAuditRetries: 3,
    }, ["publicPriceCeiling", "publicAuditRetries"]);
    (outcome.status === "accepted" ? accepted : rejected).push(outcome);
  }
  return { accepted, rejected };
}

export interface CommercialPricingEstimate {
  currency: "CNY";
  adult: number;
  child: number;
  minimumTravelers: number;
  cost: { adult: number; child: number; singleSupplement: number; childBed: number };
}

export function estimateCommercialPricing(
  skeleton: PlanningSkeleton,
  product: Record<string, unknown>,
): CommercialPricingEstimate {
  const operations = record(product.operations);
  const hotelCost = hotelNightCost(String(operations?.hotelTier ?? "")) * Math.max(0, skeleton.nights);
  const transportCost = dailyTransportCost(String(operations?.transport ?? "")) * Math.max(1, skeleton.days);
  const guideCost = guidedVisitCount(product, skeleton.days) * (skeleton.productForm === "privateTour" ? 90 : 60);
  const serviceCost = Math.max(1, skeleton.days) * 95;
  const minimumAdultCost = minimumCost(skeleton.productForm);
  const adultCost = ceilToTen(Math.max(minimumAdultCost, hotelCost + transportCost + guideCost + serviceCost));
  const childCost = ceilToTen(Math.max(
    minimumAdultCost * 0.46,
    (transportCost + guideCost) * 0.55 + serviceCost * 0.45 + hotelCost * 0.235,
  ));
  return {
    currency: "CNY",
    adult: ceilToTen(adultCost / 0.8),
    child: ceilToTen(childCost / 0.72),
    minimumTravelers: 1,
    cost: {
      adult: adultCost,
      child: childCost,
      singleSupplement: skeleton.nights > 0 ? ceilToTen(hotelNightCost(String(operations?.hotelTier ?? "")) * 1.06) : 0,
      childBed: skeleton.nights > 0 ? ceilToTen(hotelNightCost(String(operations?.hotelTier ?? "")) * 0.85) : 0,
    },
  };
}

async function writeFallback(
  args: { localProductId: string; runtime: OrchestratorRuntime },
  module: "pricing" | "inventory" | "release",
  value: object,
  acceptedFields: string[],
): Promise<ModuleOutcome> {
  const result = await args.runtime.writeModule(args.localProductId, module, AI_WRITABLE_PATHS[module], value);
  return result.ok
    ? { module, status: "accepted", writePath: AI_WRITABLE_PATHS[module], acceptedFields }
    : { module, status: "rejected", reason: result.reason || "商业默认值写入失败" };
}

function guidedVisitCount(product: Record<string, unknown>, days: number): number {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const count = itinerary.reduce((total, day) => {
    const recordDay = record(day);
    if (!String(recordDay?.description ?? "").includes("讲解")) return total;
    const spots = Array.isArray(recordDay?.spots) ? recordDay.spots : [];
    const unique = new Set(spots.map((spot) => {
      const item = record(spot);
      return String(item?.poiId ?? item?.poiName ?? item?.name ?? "").trim();
    }).filter(Boolean));
    return total + Math.min(4, unique.size);
  }, 0);
  return Math.min(Math.max(0, days) * 4, count);
}

function hotelNightCost(tier: string): number {
  if (tier.includes("5钻")) return 520;
  if (tier.includes("4钻")) return 340;
  return 220;
}

function dailyTransportCost(transport: string): number {
  if (transport === "charter") return 260;
  if (transport === "shared") return 120;
  return 0;
}

function minimumCost(productForm: PlanningSkeleton["productForm"]): number {
  if (productForm === "privateTour") return 1020;
  if (productForm === "semiSelfGuided") return 560;
  if (productForm === "groupTour") return 430;
  return 290;
}

export function hasPersistedCommercialPricing(value: unknown): boolean {
  const pricing = record(value);
  return Boolean(pricing && positiveNumber(pricing.adult) && nonnegativeNumber(pricing.child) !== undefined
    && Number.isInteger(pricing.minimumTravelers) && Number(pricing.minimumTravelers) > 0);
}

export function hasPersistedCommercialInventory(value: unknown): boolean {
  const inventory = record(value);
  const startDate = String(inventory?.startDate ?? "");
  const endDate = String(inventory?.endDate ?? "");
  return Boolean(/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    && startDate <= endDate && positiveNumber(inventory?.dailyQuota));
}

function hasPricing(value: unknown): boolean {
  return hasPersistedCommercialPricing(value);
}

function hasInventory(value: unknown): boolean {
  return hasPersistedCommercialInventory(value);
}

function hasRelease(value: unknown, adultPrice: number | undefined): boolean {
  const release = record(value);
  const retries = Number(release?.publicAuditRetries);
  const ceiling = positiveNumber(release?.publicPriceCeiling);
  return Boolean(ceiling && (!adultPrice || ceiling >= adultPrice)
    && Number.isInteger(retries) && retries >= 1 && retries <= 10);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ceilToTen(value: number): number {
  return Math.ceil(value / 10) * 10;
}

export function normaliseCommercialOutcomes(
  accepted: ModuleOutcome[],
  rejected: ModuleOutcome[],
): { accepted: ModuleOutcome[]; rejected: ModuleOutcome[] } {
  const order = ["packageName", ...STAGE_ALLOWED_MODULES.commercial] as readonly PlanningModule[];
  const acceptedByModule = new Map<PlanningModule, ModuleOutcome>();
  for (const outcome of accepted) {
    if (outcome.status === "accepted") acceptedByModule.set(outcome.module, outcome);
  }
  const rejectedByModule = new Map<PlanningModule, ModuleOutcome>();
  for (const outcome of rejected) {
    if (acceptedByModule.has(outcome.module)) continue;
    rejectedByModule.set(outcome.module, outcome);
  }
  const sortByStageOrder = (a: ModuleOutcome, b: ModuleOutcome) => order.indexOf(a.module) - order.indexOf(b.module);
  return {
    accepted: [...acceptedByModule.values()].sort(sortByStageOrder),
    rejected: [...rejectedByModule.values()].sort(sortByStageOrder),
  };
}
