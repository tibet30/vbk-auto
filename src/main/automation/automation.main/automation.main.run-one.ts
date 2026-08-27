/**
 * 自动化「单阶段重新执行」入口：runOnePhase。
 *   - 仅重跑指定 phase，其它阶段保留原状态（不全清）；
 *   - 调用 prepareSinglePhaseRetry 准备新 AutomationRun，run.status 临时变 running；
 *   - recovery 重试前会刷新目标阶段页，避免沿用上轮脏 DOM；
 *   - 完成后把 run.status 恢复为 originalRunStatus，让 UI 上的 succeeded / cancelled / failed
 *     标签不丢失。
 */

import { runPhaseWithRecovery, type RecoveryContext } from "../recovery/recovery.js";
import {
  parseProduct,
  pickKeySpotsFromItinerary,
  shouldRefillBasicInfo,
} from "../schema/schema.js";
import { prepareSinglePhaseRetry } from "../phase-retry.js";
import {
  fillAndSaveBasicInfo,
  syncSupplierProductCode,
  fillAndSavePackage,
  fillAndSaveTerms,
  fillAndSubmitPricingInventory,
  ensureHotelResource,
  ensureVehicleResource,
  openProductEditor,
  runProductPreflight,
} from "../ctrip/ctrip.js";
import { fillItineraryDraftApi } from "../ctrip/itinerary/api-entry.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { isProductImageTextUrl } from "../ctrip/tabs.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import { refreshSupplierProductCodeForPlatformWrite, resolveActiveServicePhoneContext, resolveProductButlerSelection } from "./automation.main.class.helpers.js";
import { refreshPhasePageBeforeRetry } from "./automation.main.retry-navigation.js";
import { ensurePricingInventoryApi } from "../ctrip/pricing-api.js";
import { ensurePackageApi } from "../ctrip/package-api.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import type { ContactCardSelection } from "../../../shared/contracts.js";
import { fillPresentationWithSensitiveRewrite } from "./presentation-sensitive-rewrite.js";
import { fillItineraryWithSensitiveRewrite } from "./itinerary-sensitive-rewrite.js";

/**
 * 单阶段重新执行入口：
 *   - 产品 / product 校验、管家凭证按阶段名决定是否必带；
 *   - 构造 fillMap：basic 阶段额外处理 setBasicInfoSaved + scenicSpotLogs，其它阶段直接调 fill*；
 *   - 用 makeRecoveryCtx 拿到 RecoveryContext，让 runPhaseWithRecovery 走完整 advisor 链；
 *   - cancelled / needs_user / failed 分支与 run() 保持一致；completed 时恢复原 status。
 */
export async function runOnePhase(ctx: AutomationRunContext, localProductId: string, phaseName: string) {
    const product = ctx.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const productData = parseProduct(product.product);
    const productId = product.productId;
    // 「重新执行」以前置依赖与 run() 一致：管家联系人从 product JSON 读取，
    // 400 电话从账号固定信息读取。缺少则阻断。
    const accountName = ctx.db.getSetting("vbkAccountName")?.value;
    let basicInfoSaved = product.basicInfoSaved ?? false;
    const shouldRequireAccountContext = phaseName === "basic" || !basicInfoSaved;
    let butlerSelection: ContactCardSelection | null = null;
    let servicePhone: string | null = null;
    if (shouldRequireAccountContext) {
      butlerSelection = resolveProductButlerSelection(product.product);
      if (!butlerSelection) {
        throw new Error("录入前检查未通过：产品 JSON 缺少管家联系人（请重新创建或在基础信息中写入负责人）");
      }
      const phoneContext = resolveActiveServicePhoneContext(ctx.db, accountName);
      if (!phoneContext) {
        if (!accountName) throw new Error("未检测到当前登录的 VBK 账号，无法读取 400 电话。");
        throw new Error("录入前检查未通过：400 电话（请在账号设置里维护）");
      }
      servicePhone = phoneContext.servicePhone;
      if (phoneContext.fallbackUsed) {
        ctx.db.setSetting("vbkAccountName", phoneContext.accountName);
      }
    }
    if (!shouldRequireAccountContext) {
      const phoneContext = resolveActiveServicePhoneContext(ctx.db, accountName);
      if (phoneContext?.fallbackUsed) {
        ctx.db.setSetting("vbkAccountName", phoneContext.accountName);
      }
    }
    const keySpots = pickKeySpotsFromItinerary(product.product);
    const scenicSpotLogs: string[] = [];

    const draftPhases = draftPhasesFor(productData);
    const phaseIndex = draftPhases.indexOf(phaseName);
    if (phaseIndex < 0) throw new Error(`当前产品没有阶段：${phaseName}`);
    const previousRun = product.automation!;
    const originalRunStatus = previousRun.status;
    const run = prepareSinglePhaseRetry(previousRun, draftPhases, phaseName);
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); ctx.db.saveAutomation(localProductId, run); ctx.emit(localProductId); };
    const persist = () => { ctx.db.saveAutomation(localProductId, run); ctx.emit(localProductId); };
    ctx.db.saveAutomation(localProductId, run);

    try {
      ctx.browser.setVisible(true);
      ctx.ensureBrowserHasBounds();
      const page = await ctx.browser.page({ requireInteractive: true });
      // 入口仍保留当前产品上下文；若 recovery 进入第 2/3 次 attempt，
      // applyAction 会在每次重试前刷新目标 phase 的独立页面。
      if (productId) await openProductEditor(page, productId, { stayOnCurrentTab: true });

      const phaseRecord = (phase: string) => {
        const index = draftPhases.indexOf(phase);
        if (index < 0) throw new Error(`未注册的阶段：${phase}`);
        run.currentPhase = phase;
        run.phases[index].status = "running";
        persist();
      };

      // basic 阶段特殊：会动 setBasicInfoSaved / scenicSpotLogs。其他阶段直接
      // 调 fill 函数 + 标记 completed 即可。这块逻辑与 run() 里的 handler
      // 同型 — 仅去掉 multi-phase forward 部分。
      const fillMap: Record<string, () => Promise<unknown>> = {
        presentation: () => fillPresentationWithSensitiveRewrite({ ctx, localProductId, page, product: productData, log }),
        itinerary: () => fillItineraryWithSensitiveRewrite({
          ctx,
          localProductId,
          product: productData,
          log,
          executeItinerary: () => fillItineraryDraftApi(page, productData, {
            disambiguator: ctx.disambiguator,
            productId: productId ?? "",
          }),
          dbUpdate: (id, updatedProduct, status) => ctx.db.updateProduct(id, updatedProduct, status),
        }),
        package: () => ensurePackageApi(page, productData, productId!),
        pricingInventory: () => ensurePricingInventoryApi(page, productData, productId!),
        terms: () => fillAndSaveTerms(page, productData, productId),
        hotelResource: () => ensureHotelResource(page, productData, productId!),
        vehicleResource: () => ensureVehicleResource(page, productData, productId!),
        preflight: () => runProductPreflight(page, productData, productId!),
      };
      const fillFn = fillMap[phaseName];

      const execute: () => Promise<unknown> = phaseName === "basic"
        ? async () => {
            phaseRecord("basic");
            scenicSpotLogs.length = 0;
            const refreshedSupplierCode = refreshSupplierProductCodeForPlatformWrite(productData, butlerSelection, productId);
            if (refreshedSupplierCode) {
              product.product = productData as unknown as Record<string, unknown>;
              ctx.db.updateProduct(localProductId, product.product, product.status);
              const supplierCode = String((productData.basicInfo as Record<string, unknown>).supplierProductCode);
              log(`供应商产品编号已按本次写入时间重算：${refreshedSupplierCode}`);
              if (basicInfoSaved) {
                await syncSupplierProductCode(page, supplierCode);
                log(`供应商产品编号已写入平台并完成回读：${supplierCode}`);
                run.phases[phaseIndex].status = "completed";
                return;
              }
            }
            const shouldRefill = shouldRefillBasicInfo({ productId, basicInfoSaved, product: product.product });
            log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
            if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
            // basicInfoSaved 已确认但 product 无缺失 → 跳过填充，直接标记完成。
            if (shouldRefill.reason === "complete") {
              log("basic 阶段无需重填，跳过 fillAndSaveBasicInfo");
              run.phases[phaseIndex].status = "completed";
              return;
            }
            // reason=retry 但页面可能已不在「基本信息」tab（用户已手动保存并导航
            // 到产品图文）；此时 detectCurrentTab 能判断当前是否在 presentation
            // 路径。若已在产品图文页面，视为 basic 已完成，跳过 refill。
            if (shouldRefill.reason === "retry") {
              try {
                const currentUrl = page.url();
                if (isProductImageTextUrl(currentUrl)) {
                  log("检测到页面已在产品图文，跳过 basic 阶段");
                  ctx.db.setBasicInfoSaved(localProductId);
                  run.phases[phaseIndex].status = "completed";
                  return;
                }
              } catch (_) { /* URL 读取失败，走正常 refill 路径 */ }
            }
            await fillAndSaveBasicInfo(page, productData, butlerSelection, {
              servicePhone: servicePhone || "",
              keySpots,
              scenicSpotLogs,
              disambiguator: ctx.disambiguator,
            });
            for (const entry of scenicSpotLogs) log(entry, "warning");
            ctx.db.setBasicInfoSaved(localProductId);
            run.phases[phaseIndex].status = "completed";
          }
        : async () => {
            if (!fillFn) throw new Error(`未注册的阶段：${phaseName}`);
            phaseRecord(phaseName);
            const result = await fillFn();
            if (phaseName === "vehicleResource") {
              const vehicleResult = result as { skipped?: unknown; resourceGroupId?: unknown; audited?: unknown };
              if (vehicleResult.skipped) {
                throw new Error(`用车资源重新执行未完成：${String(vehicleResult.skipped)}`);
              }
              if (!vehicleResult.resourceGroupId || vehicleResult.audited !== true) {
                throw new Error("用车资源重新执行未完成：未取得已绑定资源组的确认结果。");
              }
            }
            // hotelResource 会更新 product.operations.hotelResource；其他阶段
            // 不需要额外动作。这里与 run() 中 hotelResource handler 同型 ——
            // 都用 source / resourceId / resourceName / hotelTier / diamond
            // 几个字段判断是否需要写回产品。
            if (phaseName === "hotelResource") {
              const hr = result as { source?: unknown; resourceId?: unknown; resourceName?: unknown; hotelTier?: unknown; diamond?: unknown };
              if (hr.source === "vbk" && hr.resourceId && hr.resourceName) {
                productData.operations!.hotelResource = {
                  source: "vbk",
                  resourceId: hr.resourceId as number,
                  resourceName: String(hr.resourceName),
                  hotelTier: hr.hotelTier as "当地3钻酒店/-3" | "当地4钻酒店/-4" | "当地5钻酒店/-38" | undefined,
                  diamond: hr.diamond as 3 | 4 | 5,
                };
                ctx.db.updateProduct(localProductId, productData as unknown as Record<string, unknown>, "automating");
              }
            }
            run.phases[phaseIndex].status = "completed";
            return result;
          };

      const completedBefore = draftPhases.slice(0, phaseIndex).filter((p) => previousRun.phases.find((r) => r.phase === p)?.status === "completed");
      const recoveryCtx: RecoveryContext = {
        run,
        phase: phaseName,
        completedPhases: completedBefore,
        productIdExists: Boolean(productId),
        basicInfoSaved,
        execute,
        advisor: ctx.advisor,
        applyAction: async (action, attempt) => {
          if (action === "wait_for_user") throw new Error("applyAction 不应收到 wait_for_user");
          await refreshPhasePageBeforeRetry({ page, productId, phase: phaseName, action, attempt, log });
        },
        log,
        persist,
        shouldCancel: () => ctx.cancellationRequested.has(localProductId),
      };

      const outcome = await runPhaseWithRecovery(recoveryCtx);
      switch (outcome.status) {
        case "needs_user":
          run.status = "failed";
          run.phases[phaseIndex].status = "failed";
          run.currentPhase = phaseName;
          ctx.db.updateProduct(localProductId, productData as unknown as Record<string, unknown>, "blocked");
          break;
        case "cancelled":
          ctx.markCancelled(localProductId, run, persist);
          break;
        default: {
          // completed：恢复原 run.status。仅这个阶段被重跑过；后续阶段不动。
          // 如果原状态是 succeeded / cancelled，把它们恢复回去，UI 上「草稿已
          // 保存」/「已停止」标签能保持；若原状态就是 failed（上一轮所有阶段
          // 都没成功），恢复后仍是 failed —— 运营可再次点「重新执行」 next
          // 阶段。
          run.status = originalRunStatus === "running" ? "running" : originalRunStatus;
          run.currentPhase = undefined;
          if (run.phases.length > 0 && run.phases.every((phase) => phase.status === "completed")) {
            run.status = "succeeded";
            await finalizeRunWithScreenshot(run, saveScreenshot, productId!, page, log);
            log("产品草稿已保存，未提交审核、未发布。", "warning");
            ctx.db.updateProduct(localProductId, productData as unknown as Record<string, unknown>, "draft_saved");
          }
          break;
        }
      }
      persist();
    } catch (error) {
      if (error instanceof AutomationCancelledError) return;
      // 拋出的 handler 错误：走与 run() 同型的 failed 路径，但保留其他阶段
      // 状态（不动 completed 阶段）。
      run.status = "failed";
      run.phases[phaseIndex].status = "failed";
      run.currentPhase = phaseName;
      log(error instanceof Error ? error.message : "重新执行发生未知错误", "error");
      ctx.db.updateProduct(localProductId, productData as unknown as Record<string, unknown>, "blocked");
      persist();
      throw error;
    }
  }
