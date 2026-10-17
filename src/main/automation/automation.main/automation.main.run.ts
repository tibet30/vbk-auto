import { configureProductShellApi } from "../ctrip/sale-control/api.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { completeVerifiedSaleControlPhase, initializeAutomationStartPhase } from "./automation.main.run-state.js";
import { completeUnsupportedVehiclePhase } from "./automation.main.resource-handlers.js";
import { writeAutomationProduct } from "./automation.main.persist.js";
import { prepareAutomationSetup, type AutomationSetup } from "./automation.main.run/setup.js";
import { buildAutomationHandlers, buildBasicExecute } from "./automation.main.run/handlers.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import { automationSession, recoverDraftPhase } from "./runtime/index.js";
import { stampCompletedEntryPhase } from "../../application/product-entry-phase-fingerprint.js";

/** Complete entry and forward recovery share handlers, checkpoints and terminal transitions. */
export async function runAutomation(ctx: AutomationRunContext, localProductId: string, retryFrom?: string) {
  const setup = await prepareAutomationSetup(ctx, localProductId, retryFrom);
  const session = automationSession(ctx, localProductId, setup.run);
  const productIdRef = { current: setup.productDetail.productId };
  const assertActive = () => {
    if (ctx.cancellationRequested.has(localProductId)) throw new AutomationCancelledError();
  };
  try {
    assertActive();
    if (setup.startIndex === 0) {
      initializeAutomationStartPhase(setup.run, productIdRef.current);
      setup.persist();
      if (!productIdRef.current) {
        setup.log("正在创建 VBK 产品草稿…");
        productIdRef.current = await ctx.runVbkPageExclusive(async () => {
          assertActive();
          return configureProductShellApi(setup.page, setup.product, createdId => {
            ctx.db.setProductId(localProductId, createdId);
            setup.log(`携程已返回产品壳 ID：${createdId}，正在核验销售控制。`);
          });
        }, "saleControl");
        ctx.db.setProductId(localProductId, productIdRef.current);
        ctx.browser.addPinnedProductId?.(productIdRef.current);
        assertActive();
        completeVerifiedSaleControlPhase(setup.run);
        setup.persist();
        setup.log(`销售控制已通过远端回读：${productIdRef.current}`);
      }
    } else {
      setup.log(`已从 ${retryFrom} 阶段继续录入（通过 API 保存并回读）`);
    }
    if (!productIdRef.current) throw new Error("产品 ID 缺失，无法继续后续阶段。");
    const handlers = { ...buildAutomationHandlers(ctx, setup, productIdRef),
      basic: buildBasicExecute(ctx, setup, productIdRef) };
    for (let index = setup.startIndex; index < setup.draftPhases.length; index++) {
      assertActive();
      const phase = setup.draftPhases[index];
      if (setup.run.phases[index]?.status === "completed") {
        setup.log(`跳过已通过远端回读的阶段：${phase}`);
        continue;
      }
      if (completeUnsupportedVehiclePhase(setup.product, setup.run, phase, index, setup.log, setup.persist)) continue;
      const handler = handlers[phase as keyof typeof handlers];
      if (!handler) throw new Error(`未注册的阶段：${phase}`);
      setup.log(`正在保存：${phase}`);
      const outcome = await recoverDraftPhase({ ctx, localProductId, run: setup.run,
        page: setup.page, productId: productIdRef.current,
        manualCover: setup.product.presentation?.cover?.source === "manualUpload",
        log: setup.log, persist: setup.persist }, phase, setup.basicInfoSaved, handler);
      if (outcome.status === "cancelled") {
        session.cancel();
        return;
      }
      if (outcome.status === "needs_user") {
        if (phase === "trafficLine") continue;
        session.fail(outcome.finalError ?? `阶段 ${phase} 未完成`, phase);
        return;
      }
      stampCompletedEntryPhase(setup.run, setup.product as unknown as Record<string, unknown>, phase);
      setup.persist();
      setup.log(`已保存：${phase}`);
    }
    await finalizeRunWithScreenshot(setup.run, saveScreenshot, productIdRef.current, setup.page, setup.log);
    assertActive();
    setup.run.status = "succeeded";
    setup.run.currentPhase = undefined;
    writeAutomationProduct(ctx, localProductId, setup.product as unknown as Record<string, unknown>, "draft_saved");
    setup.log("母产品草稿已保存；交通套餐完成状态以各子产品最终回读为准。", "warning");
  } catch (error) {
    if (error instanceof AutomationCancelledError || ctx.cancellationRequested.has(localProductId)) {
      session.cancel();
      return;
    }
    session.fail(error);
    throw error;
  } finally {
    ctx.cancellationRequested.delete(localProductId);
  }
}

export type { AutomationSetup };
