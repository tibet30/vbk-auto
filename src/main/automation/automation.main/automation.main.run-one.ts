import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import { parseProduct } from "../schema/schema.js";
import { prepareSinglePhaseRetry } from "../phase-retry.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { writeAutomationProduct } from "./automation.main.persist.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import { hasProductLineResolutionFailure } from "../ctrip/basic-info/api.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { resolveRunStatusAfterSinglePhaseSuccess, settleRunAfterVerifiedPreflight } from "./automation.main.run-one-state.js";
import { inspectManualCoverAsset } from "../manual-cover-asset.js";
import { readActiveCoverFallback, placeholderDraftOnly } from "../../../shared/cover-fallback.js";
import { loadPlaceholderCoverAsset } from "../placeholder-cover-asset.js";
import { buildFillMap } from "./automation.main.run-one/fill-map.js";
import { buildBasicExecute } from "./runtime/basic.js";
import { automationAccountContext, automationSession, executeDraftPhase, recoverDraftPhase } from "./runtime/index.js";

/** Repair only the selected module; preserve every other durable stage and child checkpoint. */
export async function runOnePhase(ctx: AutomationRunContext, localProductId: string, phaseName: string) {
  const product = ctx.db.getProduct(localProductId);
  if (!product) throw productNotFound(localProductId);
  if (!product.productId) throw new Error("远程草稿尚未创建，不能重新执行阶段。");
  if (!product.automation) throw new Error("产品尚未开始自动录入。");
  if (readActiveCoverFallback(product.product)) {
    if (!placeholderDraftOnly(product.product)) throw new Error("录入前检查未通过：运营占位图仅允许未提审、未上架的草稿。");
    loadPlaceholderCoverAsset();
  }
  if (phaseName === "presentation") {
    const issue = inspectManualCoverAsset(product.product).issue;
    if (issue) throw new Error(`录入前检查未通过：${issue}`);
  }
  const productData = parseProduct(product.product);
  const phases = draftPhasesFor(productData);
  if (!phases.includes(phaseName)) throw new Error(`当前产品没有阶段：${phaseName}`);
  const basicInfoSaved = product.basicInfoSaved ?? false;
  const account = automationAccountContext(ctx.db, product.product, phaseName === "basic" || !basicInfoSaved);
  const originalRunStatus = product.automation.status;
  const run = prepareSinglePhaseRetry(product.automation, phases, phaseName);
  // A missing request surface must not leave a permanent running checkpoint.
  const page = await getVbkRequestPage(ctx.browser);
  const session = automationSession(ctx, localProductId, run);
  session.persist();
  const execution = { ctx, localProductId, run, page, productId: product.productId,
    manualCover: productData.presentation?.cover?.source === "manualUpload", ...session };
  try {
    const basicState = { productDetail: product, product: productData, run, page, ...session, ...account,
      scenicSpotLogs: [] as string[], basicInfoSaved,
      productLineBlocked: hasProductLineResolutionFailure(product.automation.recovery?.phases.basic),
      wizardAdvanceOnly: new Set<string>() };
    const fillMap = buildFillMap({ ctx, localProductId, productDetail: product, page,
      productData, productId: product.productId, run, ...session });
    const execute = phaseName === "basic"
      ? buildBasicExecute(ctx, basicState, { current: product.productId })
      : () => executeDraftPhase(execution, phaseName, fillMap[phaseName]);
    const outcome = await recoverDraftPhase(execution, phaseName, basicInfoSaved, execute);
    if (outcome.status === "cancelled") {
      session.cancel();
      return;
    }
    if (outcome.status === "needs_user" && phaseName !== "trafficLine") {
      session.fail(outcome.finalError ?? `阶段 ${phaseName} 未完成`, phaseName);
      return;
    }
    if (phaseName === "preflight" && outcome.status === "completed") {
      Object.assign(run, settleRunAfterVerifiedPreflight(run));
      session.log("最终预检已通过权威回读；母产品录入阶段已结案，交通套餐仍以各子产品最终回读为准。");
    } else {
      run.status = resolveRunStatusAfterSinglePhaseSuccess(run, originalRunStatus);
      run.currentPhase = run.status === "failed"
        ? run.phases.find(item => item.phase !== "trafficLine" && item.status === "failed")?.phase : undefined;
    }
    if (run.status === "succeeded" && !ctx.agentControlled) {
      await finalizeRunWithScreenshot(run, saveScreenshot, product.productId, page, session.log);
      if (ctx.cancellationRequested.has(localProductId)) throw new AutomationCancelledError();
      session.log("母产品草稿已保存；交通套餐完成状态以各子产品最终回读为准。", "warning");
    }
    if (!ctx.agentControlled || outcome.status === "needs_user" || run.status === "queued") {
      writeAutomationProduct(ctx, localProductId, productData as unknown as Record<string, unknown>,
        run.status === "succeeded" ? "draft_saved" : run.status === "failed" ? "blocked" : "review");
    }
    if (run.status === "queued") {
      const next = run.phases.find(item => item.status === "pending")?.phase;
      session.log(`阶段 ${phaseName} 已通过远端回读；${next ? `可从 ${next} 继续剩余录入。` : "等待继续录入。"}`);
    }
    session.persist();
  } catch (error) {
    if (error instanceof AutomationCancelledError || ctx.cancellationRequested.has(localProductId)) {
      session.cancel();
      return;
    }
    session.fail(error, phaseName);
    throw error;
  } finally {
    ctx.cancellationRequested.delete(localProductId);
  }
}
