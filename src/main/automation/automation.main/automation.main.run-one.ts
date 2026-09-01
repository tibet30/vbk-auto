/**
 * 自动化「单阶段重新执行」入口：runOnePhase。
 *   - 仅重跑指定 phase，其它阶段保留原状态（不全清）；
 *   - 调用 prepareSinglePhaseRetry 准备新 AutomationRun，run.status 临时变 running；
 *   - recovery 重试前会刷新目标阶段页，避免沿用上轮脏 DOM；
 *   - 完成后保留原有 completed / cancelled 语义；若修复了最后一个失败阶段但
 *     仍有后续 pending 阶段，则切为 queued，允许从断点继续。
 */

import { runPhaseWithRecovery, type RecoveryContext } from "../recovery/recovery.js";
import {
  parseProduct,
  pickKeySpotsFromItinerary,
  shouldRefillBasicInfo,
} from "../schema/schema.js";
import { prepareSinglePhaseRetry } from "../phase-retry.js";
import {
  fillAndSaveTerms,
} from "../ctrip/ctrip.js";
import { fillItineraryDraftApi } from "../ctrip/itinerary/api-entry.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import { refreshSupplierProductCodeForPlatformWrite, resolveActiveServicePhoneContext, resolveProductButlerSelection } from "./automation.main.class.helpers.js";
import { enterPhasePageForApi, recordPhaseRetry, refreshPhasePageAfterApi } from "./automation.main.retry-navigation.js";
import { ensurePricingInventoryApi } from "../ctrip/pricing-api.js";
import { ensurePackageApi } from "../ctrip/package-api.js";
import {
  ensureBasicInfoApi,
  hasProductLineResolutionFailure,
  isProductLineResolutionError,
} from "../ctrip/basic-info/api.js";
import { ensureHotelResourceApi } from "../ctrip/hotel-resource-api.js";
import { runProductPreflightApi } from "../ctrip/preflight-api.js";
import { ensureVehicleResourceApi } from "../ctrip/vehicle-resource-api.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import type { ContactCardSelection } from "../../../shared/contracts.js";
import { fillPresentationWithSensitiveRewrite } from "./presentation-sensitive-rewrite.js";
import { fillItineraryWithSensitiveRewrite } from "./itinerary-sensitive-rewrite.js";
import { resolveRunStatusAfterSinglePhaseSuccess } from "./automation.main.run-one-state.js";

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
    let productLineBlocked = hasProductLineResolutionFailure(
      previousRun.recovery?.phases.basic,
    );
    const originalRunStatus = previousRun.status;
    const run = prepareSinglePhaseRetry(previousRun, draftPhases, phaseName);
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); ctx.db.saveAutomation(localProductId, run); ctx.emit(localProductId); };
    const persist = () => { ctx.db.saveAutomation(localProductId, run); ctx.emit(localProductId); };
    ctx.db.saveAutomation(localProductId, run);

    try {
      const page = await ctx.browser.page();
      // 入口仍保留当前产品上下文；每个 attempt 的 executePhase 会在录入前
      // 独占页面并进入目标 phase，避免 recovery 与执行阶段重复导航。

      const phaseRecord = (phase: string) => {
        const index = draftPhases.indexOf(phase);
        if (index < 0) throw new Error(`未注册的阶段：${phase}`);
        run.currentPhase = phase;
        run.phases[index].status = "running";
        persist();
      };

      const executePhase = async (phase: string, executeApi: () => Promise<unknown>) => {
        phaseRecord(phase);
        return ctx.runVbkPageExclusive(async () => {
          if (ctx.browser.isVisible()) {
            ctx.ensureBrowserHasBounds();
            await enterPhasePageForApi({
              page,
              productId,
              phase,
              log,
              navigate: (url) => ctx.browser.navigate(url),
            });
          } else {
            log(`phase=${phase} 后台执行：VBK 页面未打开，跳过页面进入`, "info");
          }
          const result = await executeApi();
          if (ctx.browser.isVisible()) await refreshPhasePageAfterApi({ page, productId, phase, log });
          else log(`phase=${phase} API 远端回读完成：VBK 页面已关闭，跳过页面刷新`, "info");
          return result;
        });
      };

      const saveBasicInfo = async () => {
        const skipProductLine = productLineBlocked;
        if (skipProductLine) {
          log("产品线曾阻断基本信息，本次不提交产品线字段，其余信息继续保存。", "warning");
        }
        try {
          return await ensureBasicInfoApi(
            page,
            productData,
            productId!,
            butlerSelection!,
            servicePhone!,
            { skipProductLine },
          );
        } catch (error) {
          if (isProductLineResolutionError(error)) productLineBlocked = true;
          throw error;
        }
      };

      // basic 阶段特殊：会动 setBasicInfoSaved / scenicSpotLogs。其他阶段直接
      // 调 fill 函数 + 标记 completed 即可。这块逻辑与 run() 里的 handler
      // 同型 — 仅去掉 multi-phase forward 部分。
      const fillMap: Record<string, () => Promise<unknown>> = {
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
          dbUpdate: (id, updatedProduct, status) => ctx.db.updateProduct(id, updatedProduct, status),
        }),
        package: () => ensurePackageApi(page, productData, productId!),
        pricingInventory: () => ensurePricingInventoryApi(page, productData, productId!),
        terms: () => fillAndSaveTerms(page, productData, productId),
        hotelResource: () => ensureHotelResourceApi(page, productData, productId!),
        vehicleResource: () => ensureVehicleResourceApi(page, productData, productId!),
        preflight: () => runProductPreflightApi(page, productData, productId!),
      };
      const fillFn = fillMap[phaseName];

      const execute: () => Promise<unknown> = phaseName === "basic"
        ? async () => executePhase("basic", async () => {
            scenicSpotLogs.length = 0;
            const refreshedSupplierCode = refreshSupplierProductCodeForPlatformWrite(productData, butlerSelection, productId);
            if (refreshedSupplierCode) {
              product.product = productData as unknown as Record<string, unknown>;
              ctx.db.updateProduct(localProductId, product.product, product.status);
              const supplierCode = String((productData.basicInfo as Record<string, unknown>).supplierProductCode);
              log(`供应商产品编号已按本次写入时间重算：${refreshedSupplierCode}`);
              if (basicInfoSaved) {
                const result = await saveBasicInfo();
                log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
                log(`供应商产品编号已通过基本信息 API 写入并完成回读：${supplierCode}`);
                return;
              }
            }
            const shouldRefill = shouldRefillBasicInfo({ productId, basicInfoSaved, product: product.product });
            log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
            if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
            // basicInfoSaved 已确认但 product 无缺失 → 跳过填充，直接标记完成。
            if (shouldRefill.reason === "complete") {
              log("basic 阶段无需重填，跳过 fillAndSaveBasicInfo");
              return;
            }
            const result = await saveBasicInfo();
            log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
            for (const entry of scenicSpotLogs) log(entry, "warning");
            ctx.db.setBasicInfoSaved(localProductId);
          })
        : async () => {
            if (!fillFn) throw new Error(`未注册的阶段：${phaseName}`);
            return executePhase(phaseName, async () => {
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
            return result;
            });
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
          // executePhase 已负责每个 attempt 的唯一页面进入；不能在 recovery
          // 回调中提前 goto，否则会与下一次 executePhase.goto 互相取消。
          recordPhaseRetry({ productId, phase: phaseName, action, attempt, log });
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
          // completed：仅这个阶段被重跑过；后续阶段不动。若刚修复的是最后一
          // 个失败阶段，不能再把整条 run 恢复为 failed，否则 UI 会继续显示卡住。
          run.status = resolveRunStatusAfterSinglePhaseSuccess(run, originalRunStatus);
          run.currentPhase = undefined;
          if (run.status === "queued") {
            const nextPhase = run.phases.find((phase) => phase.status === "pending")?.phase;
            log(`阶段 ${phaseName} 已通过远端回读；${nextPhase ? `可从 ${nextPhase} 继续剩余录入。` : "等待继续录入。"}`);
            ctx.db.updateProduct(localProductId, productData as unknown as Record<string, unknown>, "review");
          }
          if (run.status === "succeeded") {
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
