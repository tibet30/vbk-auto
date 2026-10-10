/**
 * 单阶段重新执行 fillMap：把 presentation / itinerary / package /
 * pricingInventory / terms / hotelResource / vehicleResource / preflight
 * 8 个阶段各自的 fill 函数集中起来，主函数 runOnePhase 只挑选使用。
 *
 *   - presentation / itinerary：仍走带 rewrite 的填表函数（与 run() 一致）；
 *   - hotelResource / vehicleResource：run 完毕后会把回填的 resourceId /
 *     resourceName / hotelTier / diamond / candidates 写回 productData，
 *     让后续阶段 / UI 立刻生效；
 *   - trafficLine：调 ensureTrafficLinePhase 并把 checkpoint 里的
 *     children[].childProductId 推给 browser.addPinnedProductId；
 *   - 其余阶段直接调对应 ensure*Api。
 */

import type { AutomationRunContext } from "../automation.main.context.js";
import { fillPresentationWithSensitiveRewrite } from "../presentation-sensitive-rewrite.js";
import { fillItineraryWithSensitiveRewrite } from "../itinerary-sensitive-rewrite.js";
import { writeAutomationProduct } from "../automation.main.persist.js";
import { fillItineraryDraftApi } from "../../ctrip/itinerary/api-entry.js";
import { fillAndSaveTerms } from "../../ctrip/ctrip.js";
import { ensurePackageApi } from "../../ctrip/package-api.js";
import { ensurePricingInventoryApi } from "../../ctrip/pricing-api.js";
import { ensureHotelResourceApi } from "../../ctrip/hotel-resource-api.js";
import { ensureVehicleResourceApi } from "../../ctrip/vehicle-resource-api.js";
import { runProductPreflightApi } from "../../ctrip/preflight-api.js";
import { ensureTrafficLinePhase } from "../../ctrip/traffic-line/run-phase.js";
import { trafficRouteReviewAuthorized } from "../../../../shared/traffic-route-review-approval.js";
import { DEFAULT_TRAFFIC_LINE_CONFIG } from "../../../../shared/contracts-traffic-line.js";
import type { ProductDetail } from "../../../../shared/contracts.js";

import type { z } from "zod";
import type { productSchema } from "../../schema/schema-definitions/product.js";

/**
 * ParsedProduct is the zod-inferred type from productSchema (the source of truth
 * for parseProduct). Importing the schema directly here avoids dragging
 * parseProduct across the sub-directory while keeping full type fidelity.
 */
export type ParsedProduct = z.infer<typeof productSchema>;
// `ParsedProduct` is local; the import below was a mislabeled duplicate.

export interface FillMapContext {
  ctx: AutomationRunContext;
  localProductId: string;
  page: import("playwright").Page;
  productData: ParsedProduct;
  productId: string | undefined;
  run: import("../../../../shared/contracts.js").AutomationRun;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  persist: () => void;
}

export type FillFn = () => Promise<unknown>;

export function buildFillMap(args: FillMapContext): Record<string, FillFn> {
  const { ctx, localProductId, page, productData, productId, run, log, persist } = args;
  return {
    presentation: () => fillPresentationWithSensitiveRewrite({ ctx, localProductId, page, product: productData, productId: productId!, log }),
    itinerary: () => fillItineraryWithSensitiveRewrite({
      ctx,
      localProductId,
      product: productData,
      log,
      executeItinerary: () => fillItineraryDraftApi(page, productData, {
        disambiguator: ctx.disambiguator,
        productId: productId ?? "",
      }),
      dbUpdate: (id, updatedProduct, status) => writeAutomationProduct(ctx, id, updatedProduct, status),
    }),
    package: () => ensurePackageApi(page, productData, productId!),
    pricingInventory: () => ensurePricingInventoryApi(page, productData, productId!),
    terms: () => fillAndSaveTerms(page, productData, productId!),
    hotelResource: () => ensureHotelResourceApi(page, productData, productId!),
    vehicleResource: () => ensureVehicleResourceApi(page, productData, productId!),
    trafficLine: () => {
      return ensureTrafficLinePhase({
        page,
        parentProductId: productId!,
        routeReviewAuthorized: trafficRouteReviewAuthorized(ctx.db.getAgentSnapshot(localProductId)),
        config: productData.operations?.trafficLine ?? DEFAULT_TRAFFIC_LINE_CONFIG,
        itinerary: productData.itinerary,
        log,
        checkpoint: run.trafficLine,
        onCheckpoint: (checkpoint) => {
          run.trafficLine = checkpoint;
          for (const child of checkpoint.children) {
            if (child.childProductId) ctx.browser.addPinnedProductId?.(child.childProductId);
          }
          persist();
        },
        disambiguator: ctx.disambiguator,
        product: productData,
      });
    },
    preflight: () => runProductPreflightApi(page, productData, productId!),
  };
}

export interface HotelResourceFillResult {
  source?: unknown;
  resourceId?: unknown;
  resourceName?: unknown;
  hotelTier?: unknown;
  diamond?: unknown;
  dailyCandidates?: unknown;
}

/** 把 ensureHotelResourceApi 返回值写回 productData.operations.hotelResource。 */
export function applyHotelResourceResult(
  ctx: AutomationRunContext,
  localProductId: string,
  productDetail: ProductDetail,
  productData: ParsedProduct,
  result: HotelResourceFillResult,
): void {
  if (result.source === "vbk" && result.resourceId && result.resourceName) {
    const looseOperations = productData.operations as unknown as Record<string, unknown>;
    looseOperations.hotelResource = {
      source: "vbk",
      resourceId: result.resourceId as number,
      resourceName: String(result.resourceName),
      hotelTier: result.hotelTier as "当地3钻酒店/-3" | "当地4钻酒店/-4" | "当地5钻酒店/-38" | undefined,
      diamond: result.diamond as 3 | 4 | 5,
    };
    writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>, "automating");
    return;
  }
  if (result.source === "ctrip" && result.resourceName) {
    const looseProduct = productData as unknown as { itinerary?: Array<{ hotelCandidates?: unknown }> };
    const looseOperations = productData.operations as unknown as Record<string, unknown>;
    looseOperations.hotelResource = {
      source: "ctrip",
      resourceName: String(result.resourceName),
      hotelTier: result.hotelTier as "当地3钻酒店/-3" | "当地4钻酒店/-4" | "当地5钻酒店/-38" | undefined,
      diamond: result.diamond as 3 | 4 | 5,
      candidates: looseProduct.itinerary?.find((day) => Array.isArray(day.hotelCandidates))?.hotelCandidates,
      dailyCandidates: result.dailyCandidates,
    };
    writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>, "automating");
  }
}