/**
 * 销售控制入口的安全重执行：只负责创建尚未存在的 VBK 产品壳。
 * 它不进入 draftPhases，也不触碰 basic / 后续阶段的索引状态。
 */

import { configureProductShell } from "../ctrip/ctrip.js";
import { projectNotFound } from "../../infrastructure/db-errors.js";
import { parseProduct } from "../schema/schema.js";
import { prepareSaleControlRetry } from "../phase-retry.js";
import { runPhaseWithRecovery } from "../recovery/recovery.js";
import type { AutomationRunContext } from "./automation.main.context.js";

type ConfigureProductShell = (page: unknown, product: ReturnType<typeof parseProduct>) => Promise<string>;

export async function runSaleControlPhase(
  ctx: AutomationRunContext,
  projectId: string,
  configureShell: ConfigureProductShell = configureProductShell,
) {
  const project = ctx.db.getProject(projectId);
  if (!project) throw projectNotFound(projectId);
  if (project.productId) throw new Error("产品壳已创建（已有 productId），不能重新执行销售控制，避免重复创建产品。");
  if (!project.automation) throw new Error("项目尚未开始自动录入。");

  const product = parseProduct(project.product);
  const run = prepareSaleControlRetry(project.automation);
  const log = (message: string, level: "info" | "warning" | "error" = "info") => {
    run.logs.push({ at: new Date().toISOString(), message, level });
    ctx.db.saveAutomation(projectId, run);
    ctx.emit(projectId);
  };
  const persist = () => {
    ctx.db.saveAutomation(projectId, run);
    ctx.emit(projectId);
  };

  ctx.db.saveAutomation(projectId, run);
  ctx.db.setProjectLifecycle(projectId, { status: "automating" });
  ctx.emit(projectId);

  try {
    ctx.browser.setVisible(true);
    ctx.ensureBrowserHasBounds();
    const page = await ctx.browser.page();
    let shellAttempted = false;
    const outcome = await runPhaseWithRecovery({
      run,
      phase: "saleControl",
      completedPhases: [],
      productIdExists: false,
      basicInfoSaved: project.basicInfoSaved ?? false,
      execute: async () => {
        if (shellAttempted) {
          throw new Error("销售控制本轮已尝试创建产品壳但未取得 productId，请先在 VBK 确认结果后再继续。");
        }
        shellAttempted = true;
        const latest = ctx.db.getProject(projectId);
        if (latest?.productId) {
          throw new Error("产品壳已创建（已有 productId），不能重新执行销售控制，避免重复创建产品。");
        }
        const productId = await configureShell(page, product);
        if (!productId) throw new Error("销售控制已完成，但携程未返回产品 ID。");
        const afterCreate = ctx.db.getProject(projectId);
        if (afterCreate?.productId) {
          throw new Error("产品壳已创建（已有 productId），不能重新执行销售控制，避免重复创建产品。");
        }
        ctx.db.setProjectLifecycle(projectId, { productId: String(productId) });
      },
      advisor: ctx.advisor,
      applyAction: async (action) => {
        if (action === "wait_for_user") throw new Error("applyAction 不应收到 wait_for_user");
        log(`applyAction noop action=${action} phase=saleControl（当前页面重试偏好）`);
      },
      log,
      persist,
      shouldCancel: () => ctx.cancellationRequested.has(projectId),
    });

    if (outcome.status === "cancelled") {
      ctx.markCancelled(projectId, run, persist);
      return;
    }
    if (outcome.status !== "completed") {
      run.status = "failed";
      run.currentPhase = "saleControl";
      ctx.db.setProjectLifecycle(projectId, { status: "blocked" });
      persist();
      throw new Error(outcome.finalError || "销售控制重新执行未完成，请在 VBK 中确认后重试。");
    }

    run.status = "succeeded";
    run.currentPhase = undefined;
    log("销售控制已完成，产品壳 productId 已保存。", "info");
    ctx.db.setProjectLifecycle(projectId, { status: "draft_saved" });
    persist();
  } catch (error) {
    if (error instanceof Error && error.message === "用户中止了自动录入") return;
    if (run.status !== "failed" && run.status !== "cancelled") {
      run.status = "failed";
      run.currentPhase = "saleControl";
      log(error instanceof Error ? error.message : "销售控制重新执行发生未知错误", "error");
      ctx.db.setProjectLifecycle(projectId, { status: "blocked" });
      persist();
    }
    throw error;
  }
}
