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
import { platformResourceGateway } from '../infrastructure/platform-resource-gateway.js';
import { canonicalJson } from '../../shared/product-storage-projection.js';
import { ProductCommandConflict } from '../application/product-command-service.js';
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
        : deps.productMutations.commands.mergeChanges(ctx.localProductId, current, withChoices, 'user', { status: current.status }));
      const itinerary = Array.isArray(data.itinerary) ? data.itinerary as JsonObject[] : [];
      const basicInfo = data.basicInfo as JsonObject | undefined;
      const operations = data.operations as JsonObject | undefined;
      const city = cleanText(basicInfo?.destinationCity);
      const nights = Number(basicInfo?.nights);
      const requirements = new Map(itinerary.flatMap(day => {
        const requirement = hotelStayRequirement(data, day);
        return requirement ? [[Number(day.day), requirement] as const] : [];
      }));
      let queryIdentity = hotelQueryIdentity(data);
      let progressBaseline = get(ctx.localProductId);
      const resolved = await platformResourceGateway(deps.db, ctx.localProductId).query('daily_hotels', queryIdentity,
        () => resolveItineraryHotelCandidates(itinerary, city, nights, cleanText(operations?.hotelTier), (progress) => {
        const latest = get(ctx.localProductId);
        if (hotelQueryIdentity(latest.product) !== queryIdentity) throw new ProductCommandConflict('酒店核验条件已变化，请按最新方案重试。');
        progressBaseline = deps.productMutations.commands.mergeChanges(ctx.localProductId, progressBaseline,
          mergeResolvedHotelProgress(productData(progressBaseline), itinerary, progress), 'resource', { status: latest.status });
        queryIdentity = hotelQueryIdentity(progressBaseline.product);
      }, requirements, new Map(itinerary.map(day => [Number(day.day), hotelFallbackAllowed(instruction, Number(day.day), (operations?.hotelFallbackPolicy as JsonObject | undefined)?.allowDowngrade as boolean | undefined)])), historicalHotelCandidatePool(deps.db, ctx.localProductId), deps.resourceQueries?.hotelFetch), undefined, 'ctrip');
      return { content: safeJson(persistedItineraryHotelResult(resolved)) };
    },
  };
}

function hotelQueryIdentity(data: JsonObject): string {
  const basic = data.basicInfo as JsonObject | undefined;
  const ops = data.operations as JsonObject | undefined;
  return canonicalJson({ city: basic?.meetingCity, nights: basic?.nights, tier: ops?.hotelTier,
    fallback: ops?.hotelFallbackPolicy, days: (data.itinerary as JsonObject[] ?? []).map(day => ({
      day: day.day, requirement: hotelStayRequirement(data, day),
    })) });
}
