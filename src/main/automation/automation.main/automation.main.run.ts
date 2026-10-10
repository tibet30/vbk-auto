import { configureProductShellApi } from "../ctrip/sale-control/api.js";
import { runDraftPhaseWithRecovery } from "./optional-traffic-phase.js";
import {
  runPhaseWithRecovery,
  type RecoveryContext,
} from "../recovery/recovery.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import {
  completeVerifiedSaleControlPhase,
  initializeAutomationStartPhase,
} from "./automation.main.run-state.js";
import {
  completeUnsupportedVehiclePhase,
} from "./automation.main.resource-handlers.js";
import { writeAutomationProduct } from "./automation.main.persist.js";
import {
  prepareAutomationSetup,
  type AutomationSetup,
} from "./automation.main.run/setup.js";
import {
  buildAutomationHandlers,
  buildBasicExecute,
  executeAutomationPhase,
} from "./automation.main.run/handlers.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { recordPhaseRetry } from "./automation.main.retry-navigation.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import type { AdvisorAction } from "../../../shared/contracts-types/advisor.js";

/**
 * 单个产品自动化阶段主循环：
 *   - retryFrom 为 undefined 时从第 0 阶段跑完整轮；否则按 preparePhaseRetry 重置并按该阶段重跑；
 *   - 母产品阶段 needs_user → failed/blocked；大交通子产品失败按跳过处理，保留证据并继续预检。
 *   - 任一阶段 cancelled → ctx.markCancelled 接管；handler 抛错走 catch；
 *   - 全部完成 → status=succeeded，附 desktop-draft 截图落档。
 *
 * 把持续状态（attempts / logs / phases）持久化到 ctx.db.saveAutomation(localProductId, run)，
 * UI 端通过 ctx.emit(localProductId) 拿更新。
 *
 * 文件结构：
 *   - setup.ts    prepareAutomationSetup：拉取产品 / blocker 检查 / 解析账号 / 创建 run / page 句柄
 *   - handlers.ts executeAutomationPhase / buildBasicExecute / buildAutomationHandlers
 *   - run.ts（本文件） 主循环 + 终态 + 错误处理
 */
export async function runAutomation(
  ctx: AutomationRunContext,
  localProductId: string,
  retryFrom?: string,
) {
  const setup = await prepareAutomationSetup(ctx, localProductId, retryFrom);
  const productIdRef: { current: string | undefined } = { current: setup.productDetail.productId };

  try {
    if (setup.startIndex === 0) {
      initializeAutomationStartPhase(setup.run, productIdRef.current);
      if (!productIdRef.current) {
        setup.log("正在创建 VBK 产品草稿…");
        // configureProductShell 现在原子化完成销售控制（产品类型/形态/线路品牌
        // /分销渠道 + 点下一步），并返回携程产品 ID，不再单独调 createProductShell。
        productIdRef.current = await ctx.runVbkPageExclusive(() => configureProductShellApi(setup.page, setup.product, (createdId: string) => {
          ctx.db.setProductId(setup.productDetail.id, createdId);
          setup.log(`携程已返回产品壳 ID：${createdId}，正在核验销售控制。`);
        }), "saleControl");
        ctx.db.setProductId(setup.productDetail.id, productIdRef.current);
        ctx.browser.addPinnedProductId?.(productIdRef.current);
        // configureProductShellApi 已完成销售控制远端回读；先持久化销售控制
        // 的完成态并推送 UI，之后才开始 basic，避免 API 直连模式下阶段状态
        // 落后于实际保存结果。
        completeVerifiedSaleControlPhase(setup.run);
        setup.persist();
        setup.log(`销售控制已通过远端回读：${productIdRef.current}`);
      } else {
        setup.log("正在重跑 basic 阶段…", "warning");
      }
      if (!productIdRef.current) throw new Error("产品 ID 缺失，无法继续后续阶段。");
      setup.log(`产品基本信息阶段开始：${productIdRef.current}`);
    } else {
      // 中间阶段重试使用显式 productId，不依赖上一轮编辑器 URL。
      setup.log(`已从 ${retryFrom} 阶段继续录入（通过 API 保存并回读）`);
    }

    const handlers = buildAutomationHandlers(ctx, setup, productIdRef);
    const basicExecute = buildBasicExecute(ctx, setup, productIdRef);

    const makeCtx = (phase: string, execute: () => Promise<unknown>, phaseIndex: number): RecoveryContext => {
      const latestProductId = ctx.db.getProduct(setup.productDetail.id)?.productId;
      return {
        run: setup.run,
        phase,
        completedPhases: setup.draftPhases.slice(0, phaseIndex),
        productIdExists: Boolean(latestProductId),
        basicInfoSaved: setup.basicInfoSaved,
        execute,
        advisor: ctx.advisor,
        applyAction: async (action: AdvisorAction, attempt: number) => {
          if (action === "wait_for_user") {
            throw new Error("applyAction 不应收到 wait_for_user");
          }
          // executePhase 在每个 attempt 的开头独占页面并进入目标模块。这里若再
          // 导航，会与紧接着的 executePhase.goto 竞争并中断前一个导航。
          recordPhaseRetry({
            productId: productIdRef.current!,
            phase,
            action,
            attempt,
            log: setup.log,
          });
        },
        log: setup.log,
        persist: setup.persist,
        // 「停止」按钮会写进 cancellationRequested。recovery 在 attempt
        // 顶部检查；in-flight handler 不打断（Playwright click 跨进程无
        // 安全中断点，强制中断会让浏览器页面留下半成品状态）。
        shouldCancel: () => ctx.cancellationRequested.has(setup.productDetail.id),
      };
    };

    // 仅在 startIndex === 0（首次运行或重跑 basic）时跑 basic；中间阶段
    // 重试（startIndex > 0）偏好「在当前页面去重试」，不再强制跑 basic
    // 段，信任之前的 basic 阶段已完成，避免其 clickSection 把页面拽回
    // 「基本信息」 tab 并造成上次状态丢失。
    if (setup.startIndex === 0) {
      const basicOutcome = await runPhaseWithRecovery(makeCtx("basic", basicExecute, 0));
      if (basicOutcome.status === "needs_user") {
        setup.run.status = "failed";
        setup.run.phases[0].status = "failed";
        setup.run.currentPhase = "basic";
        writeAutomationProduct(ctx, setup.productDetail.id, setup.product as unknown as Record<string, unknown>, "blocked");
        setup.persist();
        return;
      }
      if (basicOutcome.status === "cancelled") {
        ctx.markCancelled(setup.productDetail.id, setup.run, setup.persist);
        return;
      }
    } else {
      setup.log(`跳过 basic 阶段（已保存），从 ${retryFrom} 继续并进入对应模块页面`);
    }

    if (!productIdRef.current) throw new Error("产品 ID 缺失，无法继续后续阶段。");
    setup.log(`产品基本信息已保存：${productIdRef.current}`);

    const startFrom = Math.max(1, setup.startIndex);
    for (let index = startFrom; index < setup.draftPhases.length; index += 1) {
      const phase = setup.draftPhases[index];
      if (setup.run.phases[index]?.status === "completed") {
        setup.log(`跳过已通过远端回读的阶段：${phase}`);
        continue;
      }
      if (completeUnsupportedVehiclePhase(setup.product, setup.run, phase, index, setup.log, setup.persist)) continue;
      const handler = handlers[phase];
      if (!handler) throw new Error(`未注册的阶段：${phase}`);
      setup.log(`正在保存：${phase}`);
      const outcome = await runDraftPhaseWithRecovery(makeCtx(phase, handler, index));
      if (phase === "trafficLine" && outcome.status === "needs_user") continue;
      if (outcome.status === "needs_user") {
        setup.run.status = "failed";
        setup.run.phases[index].status = "failed";
        setup.run.currentPhase = phase;
        writeAutomationProduct(ctx, setup.productDetail.id, setup.product as unknown as Record<string, unknown>, "blocked");
        setup.persist();
        return;
      }
      if (outcome.status === "cancelled") {
        ctx.markCancelled(setup.productDetail.id, setup.run, setup.persist);
        return;
      }
      setup.log(`已保存：${phase}`);
    }
    // 全部业务阶段成功后的收尾：best-effort screenshot（捕获 saveScreenshot
    // 错误，避免页面 width=0 / page 已 detach 等竞态把整条 run 误标
    // failed/blocked），然后切产品状态 draft_saved 并 persist。screenshot
    // 失败仅写一条 warning log，业务成功状态保持 succeeded + undefined +
    // draft_saved，绝不进入 failed/blocked 路径。
    setup.run.status = "succeeded";
    setup.run.currentPhase = undefined;
    await finalizeRunWithScreenshot(setup.run, saveScreenshot, productIdRef.current!, setup.page, setup.log);
    setup.log("母产品草稿已保存；交通套餐完成状态以各子产品最终回读为准。", "warning");
    writeAutomationProduct(ctx, setup.productDetail.id, setup.product as unknown as Record<string, unknown>, "draft_saved");
    setup.persist();
  } catch (error) {
    // 「停止」流程不应该被 catch 当作 failed —— stop() 已经把 run.status
    // 改为 cancelled 并 emit 过，这里只需清理 cancellationRequested 后
    // 静默返回，不要覆盖状态。
    if (error instanceof AutomationCancelledError) {
      ctx.cancellationRequested.delete(setup.productDetail.id);
      return;
    }
    // handler 内部可能因为 stop 之外的其他原因抛错 —— 现有逻辑保持不变。
    setup.run.status = "failed";
    const current = setup.run.phases.find((phase: { phase: string; status: string }) => phase.phase === setup.run.currentPhase);
    if (current && current.status !== "completed") current.status = "failed";
    setup.log(error instanceof Error ? error.message : "自动录入发生未知错误", "error");
    writeAutomationProduct(ctx, setup.productDetail.id, setup.product as unknown as Record<string, unknown>, "blocked");
    setup.persist();
    throw error;
  } finally {
    // 走完所有阶段后清理取消信号 —— 防止下一次 run 进来时拿到的 stale flag。
    ctx.cancellationRequested.delete(setup.productDetail.id);
  }
}

// 显式 re-export 不外露私有类型，但保留 IDE 跳转；AutomationSetup 是
// setup.ts / handlers.ts 之间的内部状态，仅本文件用。
export type { AutomationSetup };
