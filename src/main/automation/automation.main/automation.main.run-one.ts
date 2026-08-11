/**
 * 自动化「单阶段重新执行」入口：runOnePhase。
 *   - 仅重跑指定 phase，其它阶段保留原状态（不全清）；
 *   - 调用 prepareSinglePhaseRetry 准备新 AutomationRun，run.status 临时变 running；
 *   - 「在当前页面去重试」偏好：advice 的 reload/reopen 动作走 noop；
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
  fillAndSavePackage,
  fillAndSavePresentation,
  fillAndSaveTerms,
  fillAndSubmitPricingInventory,
  fillItineraryDraft,
  ensureHotelResource,
  ensureVehicleResource,
  openProductEditor,
  runProductPreflight,
} from "../ctrip/ctrip.js";
import { projectNotFound } from "../../infrastructure/db-errors.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { resolveActiveServicePhoneContext, resolveProductButlerSelection } from "./automation.main.class.helpers.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import type { ContactCardSelection } from "../../../shared/contracts.js";

/**
 * 单阶段重新执行入口：
 *   - 项目 / product 校验、管家凭证按阶段名决定是否必带；
 *   - 构造 fillMap：basic 阶段额外处理 setBasicInfoSaved + scenicSpotLogs，其它阶段直接调 fill*；
 *   - 用 makeRecoveryCtx 拿到 RecoveryContext，让 runPhaseWithRecovery 走完整 advisor 链；
 *   - cancelled / needs_user / failed 分支与 run() 保持一致；completed 时恢复原 status。
 */
export async function runOnePhase(ctx: AutomationRunContext, projectId: string, phaseName: string) {
    const project = ctx.db.getProject(projectId);
    if (!project) throw projectNotFound(projectId);
    const product = parseProduct(project.product);
    const productId = project.productId;
    // 「重新执行」以前置依赖与 run() 一致：管家联系人从 product JSON 读取，
    // 400 电话从账号固定信息读取。缺少则阻断。
    const accountName = ctx.db.getSetting("vbkAccountName")?.value;
    const basicInfoSaved = project.basicInfoSaved ?? false;
    const shouldRequireAccountContext = phaseName === "basic" || !basicInfoSaved;
    let butlerSelection: ContactCardSelection | null = null;
    let servicePhone: string | null = null;
    if (shouldRequireAccountContext) {
      butlerSelection = resolveProductButlerSelection(project.product);
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
    const keySpots = pickKeySpotsFromItinerary(project.product);
    const scenicSpotLogs: string[] = [];

    const draftPhases = draftPhasesFor(product);
    const phaseIndex = draftPhases.indexOf(phaseName);
    if (phaseIndex < 0) throw new Error(`当前产品没有阶段：${phaseName}`);
    const previousRun = project.automation!;
    const originalRunStatus = previousRun.status;
    const run = prepareSinglePhaseRetry(previousRun, draftPhases, phaseName);
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); ctx.db.saveAutomation(projectId, run); ctx.emit(projectId); };
    const persist = () => { ctx.db.saveAutomation(projectId, run); ctx.emit(projectId); };
    ctx.db.saveAutomation(projectId, run);

    try {
      ctx.browser.setVisible(true);
      ctx.ensureBrowserHasBounds();
      const page = await ctx.browser.page();
      // 「重新执行」复用「在当前页面去重试」偏好：不调 openProductEditor 拽回
      // 「基本信息」 tab；页面应已停在原产品某子 tab 上，由各阶段 handler 自
      // 己 clickSection 切到目标 tab。仅在 productId 还没创建时跳过 —— 这种
      // 情况调用方（retryOnePhase）已拦截。
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
        presentation: () => fillAndSavePresentation(page, product),
        itinerary: () => fillItineraryDraft(page, product, { disambiguator: ctx.disambiguator, productId: productId ?? "" }),
        package: () => fillAndSavePackage(page, product),
        pricingInventory: () => fillAndSubmitPricingInventory(page, product, productId!),
        terms: () => fillAndSaveTerms(page, product),
        hotelResource: () => ensureHotelResource(page, product, productId!),
        vehicleResource: () => ensureVehicleResource(page, product, productId!),
        preflight: () => runProductPreflight(page, product, productId!),
      };
      const fillFn = fillMap[phaseName];

      const execute: () => Promise<unknown> = phaseName === "basic"
        ? async () => {
            phaseRecord("basic");
            scenicSpotLogs.length = 0;
            const shouldRefill = shouldRefillBasicInfo({ productId, basicInfoSaved, product: project.product });
            log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
            if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
            await fillAndSaveBasicInfo(page, product, butlerSelection, {
              servicePhone: servicePhone || "",
              keySpots,
              scenicSpotLogs,
              disambiguator: ctx.disambiguator,
            });
            for (const entry of scenicSpotLogs) log(entry, "warning");
            ctx.db.setBasicInfoSaved(projectId);
            run.phases[phaseIndex].status = "completed";
          }
        : async () => {
            if (!fillFn) throw new Error(`未注册的阶段：${phaseName}`);
            phaseRecord(phaseName);
            const result = await fillFn();
            // hotelResource 会更新 product.operations.hotelResource；其他阶段
            // 不需要额外动作。这里与 run() 中 hotelResource handler 同型 ——
            // 都用 source / resourceId / resourceName / hotelTier / diamond
            // 几个字段判断是否需要写回产品。
            if (phaseName === "hotelResource") {
              const hr = result as { source?: unknown; resourceId?: unknown; resourceName?: unknown; hotelTier?: unknown; diamond?: unknown };
              if (hr.source === "vbk" && hr.resourceId && hr.resourceName) {
                product.operations!.hotelResource = {
                  source: "vbk",
                  resourceId: hr.resourceId as number,
                  resourceName: String(hr.resourceName),
                  hotelTier: hr.hotelTier as "当地3钻酒店/-3" | "当地4钻酒店/-4" | "当地5钻酒店/-38" | undefined,
                  diamond: hr.diamond as 3 | 4 | 5,
                };
                ctx.db.updateProduct(projectId, product as unknown as Record<string, unknown>, "automating");
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
        applyAction: async (action) => {
          if (action === "wait_for_user") throw new Error("applyAction 不应收到 wait_for_user");
          log(`applyAction noop action=${action} phase=${phaseName}（单阶段重试不执行 reload / reopen）`, "info");
        },
        log,
        persist,
        shouldCancel: () => ctx.cancellationRequested.has(projectId),
      };

      const outcome = await runPhaseWithRecovery(recoveryCtx);
      switch (outcome.status) {
        case "needs_user":
          run.status = "failed";
          run.phases[phaseIndex].status = "failed";
          run.currentPhase = phaseName;
          ctx.db.updateProduct(projectId, project.product, "blocked");
          break;
        case "cancelled":
          ctx.markCancelled(projectId, run, persist);
          break;
        default: {
          // completed：恢复原 run.status。仅这个阶段被重跑过；后续阶段不动。
          // 如果原状态是 succeeded / cancelled，把它们恢复回去，UI 上「草稿已
          // 保存」/「已停止」标签能保持；若原状态就是 failed（上一轮所有阶段
          // 都没成功），恢复后仍是 failed —— 运营可再次点「重新执行」 next
          // 阶段。
          run.status = originalRunStatus === "running" ? "running" : originalRunStatus;
          run.currentPhase = undefined;
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
      ctx.db.updateProduct(projectId, project.product, "blocked");
      persist();
      throw error;
    }
  }
