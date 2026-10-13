import { normalisePlatformHotelProduct, validPlatformHotelRules } from "../../shared/platform-hotel-rules.js";
import type { AgentBusinessDependencies } from "./integration-generate.js";
import type { ProductDetail } from "../../shared/contracts.js";
import type { AgentTool } from "./types.js";

/** Kept tool name for saved Agent calls; no hotel provider query is made. */
export function createItineraryHotelTool(deps: AgentBusinessDependencies, get: (id: string) => ProductDetail): AgentTool {
  return {
    name: "resolve_itinerary_hotels", description: "配置平台自动匹配三钻、四钻、五钻酒店规则，不查询或指定具体酒店。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const current = get(ctx.localProductId);
      const next = normalisePlatformHotelProduct(current.product);
      if (!validPlatformHotelRules(next.operations?.hotelRules)) throw new Error("酒店规则缺失或无效，不能完成住宿准备");
      const saved = deps.productMutations.commands.mergeChanges(ctx.localProductId, current, next, 'resource', { status: current.status });
      return { content: JSON.stringify({ persisted: true, rules: (saved.product.operations as any)?.hotelRules,
        persistenceNote: "平台酒店规则已保存，无需查询或指定具体酒店" }) };
    },
  };
}
