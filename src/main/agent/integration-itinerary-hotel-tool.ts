import { historicalHotelTierInstruction } from "./historical-hotel-tier-choices.js";
import { hotelAnswerInstruction } from "./hotel-answer-instruction.js";
import { hotelStayRequirement } from "../../shared/hotel-stay-requirement.js";
import { reconcileHotelStays } from "../../shared/reconcile-hotel-stays.js";
import { hotelDowngradePermission, hotelFallbackAllowed } from "../../shared/hotel-downgrade-policy.js";
import { applyPersistedHotelTierChoices } from "./integration-patch.js";
import { resolveItineraryHotelCandidates } from "../infrastructure/ctrip-hotel-search.js";
import { persistedItineraryHotelResult, mergeResolvedHotelProgress } from "./integration-itinerary-hotel-result.js";
import { historicalHotelCandidatePool } from "./historical-hotel-candidates.js";
import type { AgentBusinessDependencies } from "./integration-generate.js";
import type { ProductDetail } from "../../shared/contracts.js";
import type { AgentTool } from "./types.js";
type JsonObject = Record<string, unknown>;
const productData = (product: ProductDetail) => product.product as JsonObject;
const cleanText = (value: unknown) => typeof value === "string" ? value.trim() : "";
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).slice(0, 24_000);

export function createItineraryHotelTool(deps: AgentBusinessDependencies, get: (id: string) => ProductDetail): AgentTool {
  return {
    name: "resolve_itinerary_hotels", description: "为已有逐日行程查询真实酒店候选，并自动写回 itinerary[].hotelCandidates；成功后不得再用 patch_product 重写行程。", parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const current = get(ctx.localProductId);
      const instruction = [historicalHotelTierInstruction(deps.db, get(ctx.localProductId)), hotelAnswerInstruction(deps.db.getAgentSnapshot?.(ctx.localProductId)?.events ?? [])].filter(Boolean).join("\n");
      const withChoices = reconcileHotelStays(applyPersistedHotelTierChoices(productData(current), instruction));
      const permission = hotelDowngradePermission(instruction);
      if (permission !== undefined) {
        const ops = (withChoices.operations ?? {}) as JsonObject;
        withChoices.operations = { ...ops, hotelFallbackPolicy: { ...(ops.hotelFallbackPolicy as JsonObject ?? {}), allowDowngrade: permission } };
      }
      const data = productData(JSON.stringify(withChoices) === JSON.stringify(productData(current))
        ? current
        : deps.productMutations.replace(ctx.localProductId, withChoices, { status: current.status }));
      const itinerary = Array.isArray(data.itinerary) ? data.itinerary as JsonObject[] : [];
      const basicInfo = data.basicInfo as JsonObject | undefined;
      const operations = data.operations as JsonObject | undefined;
      const city = cleanText(basicInfo?.destinationCity);
      const nights = Number(basicInfo?.nights);
      const requirements = new Map(itinerary.flatMap(day => {
        const requirement = hotelStayRequirement(data, day);
        return requirement ? [[Number(day.day), requirement] as const] : [];
      }));
      const resolved = await resolveItineraryHotelCandidates(itinerary, city, nights, cleanText(operations?.hotelTier), (progress) => {
        const latest = get(ctx.localProductId);
        deps.productMutations.replace(ctx.localProductId, mergeResolvedHotelProgress(productData(latest), itinerary, progress), { status: latest.status });
      }, requirements, new Map(itinerary.map(day => [Number(day.day), hotelFallbackAllowed(instruction, Number(day.day), (operations?.hotelFallbackPolicy as JsonObject | undefined)?.allowDowngrade as boolean | undefined)])), historicalHotelCandidatePool(deps.db, ctx.localProductId));
      return { content: safeJson(persistedItineraryHotelResult(resolved)) };
    },
  };
}
