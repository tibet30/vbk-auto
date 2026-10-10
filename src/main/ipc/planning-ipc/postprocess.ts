/**
 * planning-ipc.ts 的"runPlanning 完成态后处理"工具：
 *   - applyCompletedAfterPlanningResult：规划 completed 后自动补齐封面 / 用车资源；
 *     失败只 console.info，不阻塞规划完成态；
 *   - applySearchUnavailableFallback：未登录 / 状态查询失败时的占位 fallback。
 *
 * 拆分原因：原 runPlanning 的尾部后处理占据约 90 行，单独抽出便于阅读 / 覆盖单测。
 */

import { logInfo } from "../../../shared/log-timestamp.js";
import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import { applyAutoCoverFill, applyCoverFallback } from "../../operations/cover-auto-fill.js";
import { applyAutoVehicleResourceTrigger } from "../../operations/vehicle-resource-trigger.js";
import { syncConfirmedResearchTasksToRemote } from "../../operations/research-task-remote-sync.js";
import type { MainIpcContext } from "../context.js";

export async function applyCompletedAfterPlanningResult(context: MainIpcContext, args: {
  localProductId: string;
  providerLabel: string | undefined;
}): Promise<void> {
  const { db, productWorkflows, broadcastProduct, productMutations, remoteProducts, browser } = context;
  const browserStatus = await productWorkflows
    .runVbkPageExclusive(() => browser.status())
    .catch((e: unknown) => {
      logInfo("[planning] browser not ready for auto resource resolution, skipping", {
        provider: args.providerLabel,
        error: (e as { message?: string })?.message ?? "unknown",
      });
      return null;
    });
  if (!browserStatus?.loggedIn) {
    // 未登录/状态查询失败只是暂时无法搜索；占位明确标为待重试。
    const current = db.getProduct(args.localProductId)!;
    const fallback = applyCoverFallback(current.product, "search_unavailable");
    if (fallback.written) {
      productMutations.replace(args.localProductId, fallback.nextProduct, { status: "review", notify: false });
    }
    return;
  }
  const productAfter = db.getProduct(args.localProductId)!;
  // 封面图：从携程图库搜索补齐 imageId / imageUrl
  const coverResult = await productWorkflows.runVbkPageExclusive(async () =>
    applyAutoCoverFill({
      page: await getVbkRequestPage(browser),
      product: productAfter.product,
    })).catch((e: unknown) => {
    logInfo("[planning] auto cover fill raised", {
      provider: args.providerLabel,
      error: (e as { message?: string })?.message ?? "unknown",
    });
    return null;
  });
  if (coverResult?.outcome.written) {
    productMutations.replace(args.localProductId, coverResult.nextProduct, { status: "review", notify: false });
    logInfo(coverResult.outcome.imageId
      ? "[planning] auto cover filled from Ctrip library"
      : "[planning] cover fallback staged for operator", {
      provider: args.providerLabel,
      keyword: coverResult.outcome.keyword,
      imageId: coverResult.outcome.imageId,
    });
  }
  // 用车资源组：触发 VBK 接口匹配 resourceGroupId / resourceGroupName
  const vehicleResult = await productWorkflows.runVbkPageExclusive(async () =>
    applyAutoVehicleResourceTrigger({
      page: await getVbkRequestPage(browser),
      product: db.getProduct(args.localProductId)!,
    })).catch((e: unknown) => {
    logInfo("[planning] auto vehicle resource trigger raised", {
      provider: args.providerLabel,
      error: (e as { message?: string })?.message ?? "unknown",
    });
    return null;
  });
  if (!vehicleResult?.outcome.written) return;
  productMutations.replace(args.localProductId, vehicleResult.nextProduct.product, { status: "review", notify: false });
  if (vehicleResult.outcome.resourceGroupId) {
    for (const task of vehicleResult.nextProduct.researchTasks) {
      if (task.state !== "confirmed" && task.state !== "resolved" && /用车|车辆|资源组|接送|司机/.test(task.label || "")) {
        db.markResearchAccepted(args.localProductId, task.id, vehicleResult.outcome.reason, "vbk");
      }
    }
    await syncConfirmedResearchTasksToRemote({ db, remote: remoteProducts, localProductId: args.localProductId, broadcast: broadcastProduct });
    logInfo("[planning] auto vehicle resource resolved", {
      provider: args.providerLabel,
      resourceGroupId: vehicleResult.outcome.resourceGroupId,
    });
  } else if (vehicleResult.outcome.estimatedTotalCost) {
    logInfo("[planning] vehicle requested total cost estimated", {
      provider: args.providerLabel,
      estimatedTotalCost: vehicleResult.outcome.estimatedTotalCost,
      reason: vehicleResult.outcome.reason,
    });
  } else {
    logInfo("[planning] vehicle resource not found in VBK", {
      provider: args.providerLabel,
      reason: vehicleResult.outcome.reason,
    });
  }
}