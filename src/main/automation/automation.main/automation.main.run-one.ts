/**
 * 自动化「单阶段重新执行」入口：runOnePhase。
 *   - 仅重跑指定 phase，其它阶段保留原状态（不全清）；
 *   - 调用 prepareSinglePhaseRetry 准备新 AutomationRun，run.status 临时变 running；
 *   - API 保存与回读不依赖目标页；交互式封面上传仍先进入编辑页；
 *   - 完成后保留原有 completed / cancelled 语义；若修复了最后一个失败阶段但
 *     仍有后续 pending 阶段，则切为 queued，允许从断点继续。
 *
 * 拆分子文件：
 *   - fill-map.ts：8 个阶段的 fill 函数 + hotelResource 结果写回 helper。
 *
 * 与 run()（多阶段自动跑完整轮）相比：
 *   - 产品 / product 校验、管家凭证按阶段名决定是否必带；
 *   - 构造 fillMap：basic 阶段额外处理 setBasicInfoSaved + scenicSpotLogs，其它阶段直接调 fill*；
 *   - 用 makeRecoveryCtx 拿到 RecoveryContext，让 runPhaseWithRecovery 走完整 advisor 链；
 *   - cancelled / needs_user / failed 分支与 run() 保持一致；completed 时恢复原 status。
 */

import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import type { RecoveryContext } from "../recovery/recovery.js";
import {
  parseProduct,
  shouldRefillBasicInfo,
} from "../schema/schema.js";
import { runDraftPhaseWithRecovery } from "./optional-traffic-phase.js";
import { prepareSinglePhaseRetry } from "../phase-retry.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { writeAutomationProduct } from "./automation.main.persist.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import { refreshSupplierProductCodeForPlatformWrite, resolveActiveServicePhoneContext, resolveProductButlerSelection } from "./automation.main.class.helpers.js";
import { executeApiWithPhasePageSync, recordPhaseRetry } from "./automation.main.retry-navigation.js";
import {
  ensureBasicInfoApi,
  hasProductLineResolutionFailure,
  isProductLineResolutionError,
} from "../ctrip/basic-info/api.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import type { ContactCardSelection } from "../../../shared/contracts.js";
import { resolveRunStatusAfterSinglePhaseSuccess, settleRunAfterVerifiedPreflight } from "./automation.main.run-one-state.js";
import { inspectManualCoverAsset } from "../manual-cover-asset.js";
import { readActiveCoverFallback, placeholderDraftOnly } from "../../../shared/cover-fallback.js";
import { loadPlaceholderCoverAsset } from "../placeholder-cover-asset.js";
import { applyHotelResourceResult, buildFillMap, type FillMapContext } from "./automation.main.run-one/fill-map.js";

export async function runOnePhase(ctx: AutomationRunContext, localProductId: string, phaseName: string) {
    const product = ctx.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    if (readActiveCoverFallback(product.product)) {
      if (!placeholderDraftOnly(product.product)) throw new Error("录入前检查未通过：运营占位图仅允许未提审、未上架的草稿。");
      loadPlaceholderCoverAsset();
    }
    if (phaseName === "presentation") {
      const issue = inspectManualCoverAsset(product.product).issue;
      if (issue) throw new Error(`录入前检查未通过：${issue}`);
    }
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
      const page = await getVbkRequestPage(ctx.browser);
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
          return executeApiWithPhasePageSync({
            page,
            productId,
            phase,
            log,
            isPageVisible: () => ctx.browser.isVisible(),
            ensureBrowserHasBounds: ctx.ensureBrowserHasBounds,
            navigate: (url) => ctx.browser.navigate(url),
            requiresPhasePage: phase === "presentation" && productData.presentation?.cover?.source === "manualUpload",
            executeApi,
          });
        }, phase);
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

      const fillMap = buildFillMap({ ctx, localProductId, page, productData, productId: productId ?? undefined, run, log, persist } satisfies FillMapContext);

      const execute: () => Promise<unknown> = phaseName === "basic"
        ? async () => executePhase("basic", async () => {
            const scenicSpotLogs: string[] = [];
            scenicSpotLogs.length = 0;
            const refreshedSupplierCode = refreshSupplierProductCodeForPlatformWrite(productData, butlerSelection, productId);
            if (refreshedSupplierCode) {
              product.product = productData as unknown as Record<string, unknown>;
              writeAutomationProduct(ctx, localProductId, product.product, product.status);
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
            if (!ctx.agentControlled && shouldRefill.reason === "complete") {
              log("basic 阶段无需重填，跳过 fillAndSaveBasicInfo");
              return;
            }
            const result = await saveBasicInfo();
            log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
            for (const entry of scenicSpotLogs) log(entry, "warning");
            ctx.db.setBasicInfoSaved(localProductId);
          })
        : async () => {
            const fillFn = fillMap[phaseName];
            if (!fillFn) throw new Error(`未注册的阶段：${phaseName}`);
            return executePhase(phaseName, async () => {
            const outcome = await fillFn();
            if (phaseName === "vehicleResource") {
              const vehicleResult = outcome as { skipped?: unknown; resourceGroupId?: unknown; audited?: unknown };
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
              applyHotelResourceResult(ctx, localProductId, product, productData, outcome as { source?: unknown; resourceId?: unknown; resourceName?: unknown; hotelTier?: unknown; diamond?: unknown; dailyCandidates?: unknown });
            }
            return outcome;
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

      const outcome = await runDraftPhaseWithRecovery(recoveryCtx);
      switch (outcome.status) {
        case "needs_user":
          if (phaseName === "trafficLine") {
            run.status = resolveRunStatusAfterSinglePhaseSuccess(run, originalRunStatus);
            run.currentPhase = undefined;
            writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>,
              run.status === "succeeded" ? "draft_saved" : run.status === "failed" ? "blocked" : "review");
            break;
          }
          run.status = "failed";
          run.phases[phaseIndex].status = "failed";
          run.currentPhase = phaseName;
          writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>, "blocked");
          break;
        case "cancelled":
          ctx.markCancelled(localProductId, run, persist);
          break;
        default: {
          // completed：仅这个阶段被重跑过；后续阶段不动。若刚修复的是最后一
          // 个失败阶段，不能再把整条 run 恢复为 failed，否则 UI 会继续显示卡住。
          if (phaseName === "preflight") {
            Object.assign(run, settleRunAfterVerifiedPreflight(run));
            log("最终预检已通过权威回读；母产品录入阶段已结案，交通套餐仍以各子产品最终回读为准。");
          } else {
            run.status = resolveRunStatusAfterSinglePhaseSuccess(run, originalRunStatus);
            run.currentPhase = undefined;
          }
          if (run.status === "queued") {
            const nextPhase = run.phases.find((phase) => phase.status === "pending")?.phase;
            log(`阶段 ${phaseName} 已通过远端回读；${nextPhase ? `可从 ${nextPhase} 继续剩余录入。` : "等待继续录入。"}`);
            writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>, "review");
          }
          if (run.status === "succeeded" && !ctx.agentControlled) {
            await finalizeRunWithScreenshot(run, saveScreenshot, productId!, page, log);
            log("母产品草稿已保存；交通套餐完成状态以各子产品最终回读为准。", "warning");
            writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>, "draft_saved");
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
      writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>, "blocked");
      persist();
      throw error;
    }
  }