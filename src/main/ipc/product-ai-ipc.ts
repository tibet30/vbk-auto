import { logInfo } from "../../shared/log-timestamp.js";
import type { AiUsageEvent, ManualReviewFieldInput } from "../../shared/contracts.js";
import { parseProduct } from "../automation/schema/schema.js";
import { resolveVehicleResource } from "../operations/vehicle-resource.js";
import { resolveHotelResource } from "../operations/hotel-resource.js";
import { applyManualReviewField } from "../operations/manual-review-field.js";
import { refreshSatisfiedResearchTasks } from "../operations/research-refresh.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { flushProductAiUsage } from "../ai/flush-product-ai-usage.js";
import { recordAgentUsage } from "../agent/integration-usage.js";
import { getCtripSightAvailability } from "../infrastructure/ctrip-sight-availability.js";
import type { MainIpcContext } from "./context.js";

export function registerProductAiIpc(context: MainIpcContext): void {
  const { db, emitProduct, readiness, getSettings, aiService, productMutations, remoteProducts, broadcastProduct } = context;

  ipcMain.handle("products:readiness", (_event, id: string) => readiness(id));
  ipcMain.handle("products:updateProductJson", (_event, id: string, json: string) => {
    context.productWorkflows.assertIdle(id, "manual");
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    let next: Record<string, unknown>;
    try { next = JSON.parse(json); } catch { throw new Error("产品 JSON 无法解析，请检查格式。"); }
    parseProduct(next);
    return productMutations.replace(id, next, {
      status: "review",
      allowMeetingCityCorrection: true,
    });
  });

  // Manual review fields are validated against their whitelist and committed
  // together with any research tasks they satisfy.
  ipcMain.handle("products:updateReviewField", async (event, id: string, input: ManualReviewFieldInput) => {
    assertTrustedSender(event, "products:updateReviewField");
    context.productWorkflows.assertIdle(id, "manual");
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    if (input.field === "itinerarySpotPoi") {
      const availability = await context.productWorkflows.runVbkPageExclusive(() =>
        getCtripSightAvailability(context.browser, input.poiId, db));
      if (availability.status === "suspended") {
        throw new Error(`“${input.poiName}”在携程景点详情中标记为${availability.openStatus}，不能加入行程。`);
      }
    }
    const next = applyManualReviewField(product.product, input);
    parseProduct(next);
    const { product: saved, confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(id, next, { status: "review" });
    if (confirmedTaskIds.length > 0) {
      logInfo("[products:updateReviewField] sync-confirmed research task", {
        localProductId: id,
        field: input.field,
        confirmedTaskIds,
      });
    }
    broadcastProduct(saved);
    emitProduct(saved);
    return saved;
  });

  // Released renderers may still call these channels. They now delegate to the
  // same durable Agent state machine used by the current conversation UI.
  ipcMain.handle("ai:send", async (_event, localProductId: string, content: string) => {
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    context.memoryService?.captureExplicitFromUserMessage(content, {
      localProductId,
      sourceKind: "ai:user",
    });
    const snapshot = await context.agentCore.send(localProductId, content);
    context.emitAgentSnapshot?.(snapshot);
    return snapshot;
  });
  ipcMain.handle("ai:cancel", async (_event, localProductId: string) => {
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    const snapshot = await context.agentCore.pause(localProductId);
    context.emitAgentSnapshot?.(snapshot);
    return { cancelled: snapshot.run?.status === "paused" };
  });

  ipcMain.handle("ai:regenerate", async (_event, localProductId: string, field: string) => {
    if (field !== "subtitle") {
      throw new Error("AI 字段级重新生成目前仅支持副标题，请回到对话面板继续沟通。");
    }
    const product = db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    return context.productWorkflows.runExclusive(localProductId, "ai", async () => {
      const turnSettings = getSettings();
      const service = await aiService(turnSettings);
      const usageEvents: AiUsageEvent[] = [];
      const subtitle = await service.regenerateSubtitle({
        product: product.product,
        usage: { localProductId, onEvent: (event) => usageEvents.push(event) },
      });
      if (usageEvents.length > 0) {
        usageEvents.forEach((event) => recordAgentUsage(db, localProductId, event));
        await flushProductAiUsage({
          remote: remoteProducts,
          localProductId,
          events: usageEvents,
          importSnapshot: (snapshot) => db.importProductSnapshot(snapshot),
          broadcast: broadcastProduct,
        });
        const snapshot = db.getAgentSnapshot(localProductId);
        if (snapshot) context.emitAgentSnapshot?.(snapshot);
      }
      logInfo("[ai:regenerate] subtitle candidate generated", { localProductId, provider: turnSettings.aiProvider });
      return subtitle;
    });
  });

  ipcMain.handle("research:accept", (_event, localProductId: string, taskId: string, note?: string) => {
    db.markResearchAccepted(localProductId, taskId, note);
    emitProduct(db.getProduct(localProductId)!);
    return { accepted: true };
  });
  ipcMain.handle("research:refreshIssues", (_event, localProductId: string) => {
    const product = db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const result = refreshSatisfiedResearchTasks(db, localProductId);
    const next = db.getProduct(localProductId)!;
    emitProduct(next);
    return { ...result, product: next, readiness: readiness(localProductId) };
  });
  ipcMain.handle("research:vehicleResource", (_event, localProductId: string, taskId?: string) =>
    context.productWorkflows.runExclusive(localProductId, "resource", () =>
      context.productWorkflows.runVbkPageExclusive(async () => {
        const product = db.getProduct(localProductId);
        if (!product) throw productNotFound(localProductId);
        const result = await resolveVehicleResource(await context.browser.page(), product);
        productMutations.replace(localProductId, result.product, { status: "review", notify: false });
        if (result.resolved && taskId) db.markResearchAccepted(localProductId, taskId, result.note, "vbk");
        const message = result.resolved
          ? `已完成用车估算和 VBK 资源组匹配：${result.note}`
          : `用车建议价已保留，但 VBK 资源组暂未匹配成功：${result.note}`;
        db.addMessage(localProductId, "assistant", message, result.resolved ? "succeeded" : "failed");
        emitProduct(db.getProduct(localProductId)!);
        return result.resolved;
      })));
  ipcMain.handle("research:hotelResource", (_event, localProductId: string, taskId?: string) =>
    context.productWorkflows.runExclusive(localProductId, "resource", () =>
      context.productWorkflows.runVbkPageExclusive(async () => {
        const product = db.getProduct(localProductId);
        if (!product) throw productNotFound(localProductId);
        const result = await resolveHotelResource(await context.browser.page(), product);
        productMutations.replace(localProductId, result.product, { status: "review", notify: false });
        if (taskId) db.markResearchAccepted(localProductId, taskId, result.note, "vbk");
        db.addMessage(localProductId, "assistant", `已查询酒店资源：${result.note}`, "succeeded");
        emitProduct(db.getProduct(localProductId)!);
        return result.resolved;
      })));
}
