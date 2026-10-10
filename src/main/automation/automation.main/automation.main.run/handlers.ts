/**
 * automation.main.run phase handler 实现：
 *   - executeAutomationPhase：把单个阶段包裹成可被 runPhaseWithRecovery / runDraftPhaseWithRecovery 复用的执行单元
 *   - basicExecute：第 0 阶段的 special-case 处理器（处理 supplierProductCode 重新计算等）
 *   - buildAutomationHandlers：返回 phase 名 → handler 的 map
 *
 * 调用方：automation.main.run.ts 在主循环里用这些 helper 完成阶段调度。
 *
 * productId 通过 { current } 引用传入，因为第 0 阶段在 createProductShell 之后会更新它。
 */

import { fillAndSaveTerms } from "../../ctrip/ctrip.js";
import { fillItineraryDraftApi } from "../../ctrip/itinerary/api-entry.js";
import { ensurePackageApi } from "../../ctrip/package-api.js";
import { ensurePricingInventoryApi } from "../../ctrip/pricing-api.js";
import { ensureBasicInfoApi } from "../../ctrip/basic-info/api.js";
import { shouldRefillBasicInfo } from "../../schema/schema.js";
import { fillPresentationWithSensitiveRewrite } from "../presentation-sensitive-rewrite.js";
import { fillItineraryWithSensitiveRewrite } from "../itinerary-sensitive-rewrite.js";
import { writeAutomationProduct } from "../automation.main.persist.js";
import {
  resourcePhaseHandlers,
} from "../automation.main.resource-handlers.js";
import { refreshSupplierProductCodeForPlatformWrite } from "../automation.main.class.helpers.js";
import { executeApiWithPhasePageSync } from "../automation.main.retry-navigation.js";
import type { AutomationRunContext } from "../automation.main.context.js";
import type { AutomationSetup } from "./setup.js";

const TIMEOUT_VBK_RECOVERY_REGEX = /VBK 行程关联保存.*超时/u;

/**
 * 把单个 phase 包裹成可被 runPhaseWithRecovery / runDraftPhaseWithRecovery 复用的执行单元。
 * 同时持有 phaseRecord（让 run.currentPhase 实时更新并持久化）和 executeApiWithPhasePageSync（页面同步）。
 */
export function executeAutomationPhase(
  ctx: AutomationRunContext,
  setup: AutomationSetup,
  phase: string,
  productId: string,
  executeApi: () => Promise<unknown>,
): Promise<unknown> {
  const phaseRecord = (targetPhase: string) => {
    const index = setup.draftPhases.indexOf(targetPhase);
    if (index < 0) throw new Error(`未注册的阶段：${targetPhase}`);
    setup.run.currentPhase = targetPhase;
    setup.run.phases[index].status = "running";
    setup.persist();
  };

  phaseRecord(phase);
  return ctx.runVbkPageExclusive(async () => {
    return executeApiWithPhasePageSync({
      page: setup.page,
      productId,
      phase,
      log: setup.log,
      isPageVisible: () => ctx.browser.isVisible(),
      ensureBrowserHasBounds: ctx.ensureBrowserHasBounds,
      navigate: (url: string) => ctx.browser.navigate(url),
      requiresPhasePage: phase === "presentation"
        && setup.product.presentation?.cover?.source === "manualUpload",
      executeApi,
    });
  }, phase);
}

/**
 * 第 0 阶段 — basic 的特殊版：处理 supplierProductCode 重新计算、scenicSpotLogs 重置、
 * 跳过已完成 basic 但需要 refresh supplierCode 的情况。
 */
export function buildBasicExecute(
  ctx: AutomationRunContext,
  setup: AutomationSetup,
  productIdRef: { current: string | undefined },
) {
  return async () => executeAutomationPhase(ctx, setup, "basic", productIdRef.current!, async () => {
    const { productDetail, product, butlerSelection, servicePhone, scenicSpotLogs } = setup;

    // runner 重试本阶段时清空 scenicSpotLogs，防止把上一轮未命中的景点
    // 单项重复记入 automation 日志。
    scenicSpotLogs.length = 0;
    const refreshedSupplierCode = refreshSupplierProductCodeForPlatformWrite(product, butlerSelection, productIdRef.current);
    if (refreshedSupplierCode) {
      productDetail.product = product as unknown as Record<string, unknown>;
      writeAutomationProduct(ctx, setup.productDetail.id, productDetail.product, "automating");
      const supplierCode = String((product.basicInfo as Record<string, unknown>).supplierProductCode);
      setup.log(`供应商产品编号已按本次写入时间重算：${refreshedSupplierCode}`);
      if (setup.basicInfoSaved) {
        const result = await ensureBasicInfoApi(
          setup.page,
          product,
          productIdRef.current!,
          butlerSelection!,
          servicePhone,
          { skipProductLine: setup.productLineBlocked },
        );
        setup.log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
        setup.log(`供应商产品编号已通过基本信息 API 写入并完成回读：${supplierCode}`);
        return;
      }
    }
    const shouldRefill = shouldRefillBasicInfo({
      productId: productIdRef.current,
      basicInfoSaved: setup.basicInfoSaved,
      product: productDetail.product,
    });
    setup.log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
    if (!productIdRef.current) throw new Error("产品 ID 缺失，无法继续后续阶段。");
    if (shouldRefill.reason === "complete") {
      setup.log("basic 阶段已保存且产品数据完整，跳过重复填充");
      return;
    }
    const result = await ensureBasicInfoApi(
      setup.page,
      product,
      productIdRef.current,
      butlerSelection!,
      servicePhone,
      { skipProductLine: setup.productLineBlocked },
    );
    setup.log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
    // 把景点未命中的单项沉淀到 automation 日志。
    for (const entry of scenicSpotLogs) setup.log(entry, "warning");
    // 仅当 VBK API 保存并完成远端回读后置位，失败路径不会误标。
    ctx.db.setBasicInfoSaved(setup.productDetail.id);
    setup.basicInfoSaved = true;
  });
}

/**
 * 构造 phase 名 → handler 的 map。productId 通过 ref 传入以便 basic 阶段在远端回读后更新。
 */
export function buildAutomationHandlers(
  ctx: AutomationRunContext,
  setup: AutomationSetup,
  productIdRef: { current: string | undefined },
): Record<string, () => Promise<unknown>> {
  return {
    presentation: () => executeAutomationPhase(ctx, setup, "presentation", productIdRef.current!, () =>
      fillPresentationWithSensitiveRewrite({
        ctx,
        localProductId: setup.productDetail.id,
        page: setup.page,
        product: setup.product,
        productId: productIdRef.current!,
        log: setup.log,
      })),
    itinerary: () => executeAutomationPhase(ctx, setup, "itinerary", productIdRef.current!, () =>
      fillItineraryWithSensitiveRewrite({
        ctx,
        localProductId: setup.productDetail.id,
        product: setup.product,
        log: setup.log,
        executeItinerary: () => fillItineraryDraftApi(setup.page, setup.product, {
          disambiguator: ctx.disambiguator,
          readOnlyBeforeWrite: TIMEOUT_VBK_RECOVERY_REGEX.test(
            setup.productDetail.automation?.recovery?.phases?.itinerary?.finalError ?? "",
          ),
          productId: productIdRef.current,
        }),
        dbUpdate: (id: string, updatedProduct: Record<string, unknown>, status) =>
          writeAutomationProduct(ctx, id, updatedProduct, status),
      })),
    package: () => executeAutomationPhase(ctx, setup, "package", productIdRef.current!, () =>
      ensurePackageApi(setup.page, setup.product, productIdRef.current!)),
    pricingInventory: () => executeAutomationPhase(ctx, setup, "pricingInventory", productIdRef.current!, () =>
      ensurePricingInventoryApi(setup.page, setup.product, productIdRef.current!, {
        onProgress: (message: string, level?: "info" | "warning" | "error") => setup.log(message, level ?? "info"),
      })),
    terms: () => executeAutomationPhase(ctx, setup, "terms", productIdRef.current!, () =>
      fillAndSaveTerms(setup.page, setup.product, productIdRef.current)),
    ...resourcePhaseHandlers({
      ctx,
      localProductId: setup.productDetail.id,
      page: setup.page,
      product: setup.product,
      productId: productIdRef.current!,
      run: setup.run,
      log: setup.log,
      persist: setup.persist,
      executePhase: (phase: string, executeApi: () => Promise<unknown>) =>
        executeAutomationPhase(ctx, setup, phase, productIdRef.current!, executeApi),
    }),
    preflight: () => executeAutomationPhase(ctx, setup, "preflight", productIdRef.current!, () =>
      import("../../ctrip/preflight-api.js").then((mod) => mod.runProductPreflightApi(setup.page, setup.product, productIdRef.current!))),
  };
}
