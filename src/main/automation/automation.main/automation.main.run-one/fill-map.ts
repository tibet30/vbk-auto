import { normalisePlatformHotelProduct } from "../../../../shared/platform-hotel-rules.js";
/**
 * 完整录入与单阶段修复共用 fillMap：把 presentation / itinerary / package /
 * pricingInventory / terms / hotelResource / vehicleResource / preflight
 * 各阶段的 fill 函数集中起来，runner 按执行计划挑选使用。
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
import { advanceSavedProductWizardStage } from "../../ctrip/product-wizard.js";
import { AutomationCancelledError } from "../automation.main.errors.js";
import { trafficRouteReviewAuthorized } from "../../../../shared/traffic-route-review-approval.js";
import {
  canReuseVerifiedItineraryReview,
  canResumeVerifiedItineraryReviewOnly,
  runWorkflowItineraryReviewUnlock,
} from "../runtime/itinerary-review-unlock.js";
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
  productDetail?: ProductDetail;
  wizardAdvanceOnly?: ReadonlySet<string>;
}

export type FillFn = () => Promise<unknown>;

export function buildFillMap(args: FillMapContext): Record<string, FillFn> {
  const { ctx, localProductId, page, productData, productId, run, log, persist } = args;
  const assertPresentationAdvanceCurrent = async () => {
    if (ctx.cancellationRequested.has(localProductId)) throw new AutomationCancelledError();
    if (ctx.agentControlled && !ctx.assertWriteAuthorized) {
      throw new Error("产品图文下一步写入授权校验尚未就绪");
    }
    await ctx.assertWriteAuthorized?.(localProductId, "presentation");
    if (ctx.cancellationRequested.has(localProductId)) throw new AutomationCancelledError();
  };
  const unlockItineraryReview = () => runWorkflowItineraryReviewUnlock({
    localProductId, productId: productId!, product: productData, page,
    snapshot: () => ctx.db.getAgentSnapshot(localProductId),
    productIdentity: () => ctx.db.getProduct(localProductId)?.productId,
    accountIdentity: () => ctx.db.getSetting("vbkActiveAccountKey")?.value,
    cancelled: () => ctx.cancellationRequested.has(localProductId),
    assertAuthorized: async () => {
      if (!ctx.assertWriteAuthorized) throw new Error("自动录入写入授权校验尚未就绪");
      await ctx.assertWriteAuthorized(localProductId, "itinerary");
    },
    stateStore: {
      get: id => ctx.db.getItineraryReviewUnlockState(id),
      save: state => ctx.db.saveItineraryReviewUnlockState(state),
    },
  });
  const requireItineraryReviewUnlock = async () => {
    const previous = ctx.db.getItineraryReviewUnlockState(localProductId);
    if (previous?.status === "verified" && previous.productId === productId && previous.receipt) {
      return previous.receipt;
    }
    const result = await unlockItineraryReview();
    if ("skipped" in result) {
      throw new Error("行程草稿已保存；“提交审核并下一步”需要本次独立授权，未继续套餐及后续模块。");
    }
    return result.receipt;
  };
  return {
    presentation: async () => {
      if (args.wizardAdvanceOnly?.has("presentation")) {
        const advanced = await advanceSavedProductWizardStage(
          page, productId!, "pictureAndText", { assertCurrent: assertPresentationAdvanceCurrent },
        );
        if (advanced.advanced) log("产品图文已按 VBK 官方下一步推进，行程描述已解锁。");
        return advanced;
      }
      const result = await fillPresentationWithSensitiveRewrite({ ctx, localProductId, page, product: productData, productId: productId!, log });
      const advanced = await advanceSavedProductWizardStage(
        page, productId!, "pictureAndText", { assertCurrent: assertPresentationAdvanceCurrent },
      );
      if (advanced.advanced) log("产品图文已按 VBK 官方下一步推进，行程描述已解锁。");
      return result;
    },
    itinerary: async () => {
      if (canReuseVerifiedItineraryReview({
        snapshot: ctx.db.getAgentSnapshot(localProductId),
        state: ctx.db.getItineraryReviewUnlockState(localProductId),
        productId: productId!,
      })) {
        const receipt = await requireItineraryReviewUnlock();
        log("已复用本次批准流程的行程审核完整回读，不重复保存或提交审核。", "warning");
        return { reviewOnly: true, receipt };
      }
      if (canResumeVerifiedItineraryReviewOnly({
        snapshot: ctx.db.getAgentSnapshot(localProductId),
        state: ctx.db.getItineraryReviewUnlockState(localProductId),
        productId: productId!,
      })) {
        const receipt = await requireItineraryReviewUnlock();
        log("已跳过重复保存行程；只读方案核验通过，继续本次已批准的行程审核。", "warning");
        return { reviewOnly: true, receipt };
      }
      const result = await fillItineraryWithSensitiveRewrite({
        ctx,
        localProductId,
        product: productData,
        log,
        executeItinerary: () => fillItineraryDraftApi(page, productData, {
          disambiguator: ctx.disambiguator,
          productId: productId ?? "",
          readOnlyBeforeWrite: /VBK 行程关联保存.*超时/u.test(
            args.productDetail?.automation?.recovery?.phases.itinerary?.finalError ?? ""),
        }),
        dbUpdate: (id, updatedProduct, status) => writeAutomationProduct(ctx, id, updatedProduct, status),
      });
      await requireItineraryReviewUnlock();
      return result;
    },
    package: () => ensurePackageApi(page, productData, productId!),
    pricingInventory: () => ensurePricingInventoryApi(page, productData, productId!, { onProgress: log }),
    terms: () => fillAndSaveTerms(page, productData, productId!),
    hotelResource: async () => {
      const result = await ensureHotelResourceApi(page, productData, productId!);
      if ("source" in result) applyHotelResourceResult(ctx, localProductId, args.productDetail, productData, result);
      return result;
    },
    vehicleResource: async () => {
      const result = await ensureVehicleResourceApi(page, productData, productId!);
      if ("skipped" in result) throw new Error(`用车资源重新执行未完成：${String(result.skipped)}`);
      if (!result.resourceGroupId || result.audited !== true) {
        throw new Error("用车资源重新执行未完成：未取得已绑定资源组的确认结果。");
      }
      return result;
    },
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
    preflight: async () => {
      if (!ctx.agentControlled) return runProductPreflightApi(page, productData, productId!);
      const receipt = await requireItineraryReviewUnlock();
      const result = await runProductPreflightApi(page, productData, productId!, {
        itineraryTourInfoId: receipt.tourInfoId,
      });
      if (!result.menus.fullyUnlocked) throw new Error("行程审核后菜单未保持全部解锁，已停止完成预检。");
      return result;
    },
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
  productDetail: ProductDetail | undefined,
  productData: ParsedProduct,
  result: HotelResourceFillResult,
): void {
  if (result.source === "rules") {
    const normalized = normalisePlatformHotelProduct(productData);
    Object.assign(productData, normalized);
    writeAutomationProduct(ctx, localProductId, normalized, "automating");
    return;
  }
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
