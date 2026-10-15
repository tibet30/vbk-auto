import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { productJsonSaveStatus } from "../operations/product-json-save-policy.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";
import type { AiUsageEvent, ManualReviewFieldInput } from "../../shared/contracts.js";
import { parseProduct } from "../automation/schema/schema.js";
import { resolveVehicleResource } from "../operations/vehicle-resource.js";
import { resolveHotelResource } from "../operations/hotel-resource.js";
import { applyManualReviewField } from "../operations/manual-review-field.js";
import { manualReviewSavePolicy } from "../operations/manual-review-save-policy.js";
import { refreshSatisfiedResearchTasks, shouldSyncConfirmedResearchTasks } from "../operations/research-refresh.js";
import { syncConfirmedResearchTasksToRemote } from "../operations/research-task-remote-sync.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { flushProductAiUsage } from "../ai/flush-product-ai-usage.js";
import { recordAgentUsage } from "../agent/integration-usage.js";
import { getCtripSightAvailability } from "../infrastructure/ctrip-sight-availability.js";
import { clearReappearedTrustedOperatorItineraryRemovals, sameTrustedOperatorItineraryRemovals } from "../../shared/trusted-operator-itinerary-removals.js";
import type { MainIpcContext } from "./context.js";
import { canonicalJson } from '../../shared/product-storage-projection.js';
import { platformResourceGateway } from '../infrastructure/platform-resource-gateway.js';
import { suggestPoiDetail } from "../infrastructure/poi-suggest.js";
import { verifyManualPoiSelection, verifiedMappingForManualPoi } from "../operations/manual-review-poi-selection.js";

async function reconcileSavedProductQuestion(context: MainIpcContext, id: string): Promise<void> {
  try {
    await context.agentCore?.reconcilePendingInput(id);
  } catch (error) {
    // The product was already committed. Keep its save response truthful; the
    // next Agent read will retry reconciliation against the persisted value.
    logWarn("[products] pending Agent question reconciliation failed", { localProductId: id, error });
  }
}

export function registerProductAiIpc(context: MainIpcContext): void {
  const { db, emitProduct, readiness, getSettings, aiService, productMutations, remoteProducts, broadcastProduct } = context;

  ipcMain.handle("products:readiness", (_event, id: string) => readiness(id));
  ipcMain.handle("products:updateProductJson", async (_event, id: string, json: string) => {
    context.productWorkflows.assertIdle(id, "manual");
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    let next: Record<string, unknown>;
    try { next = JSON.parse(json); } catch { throw new Error("产品 JSON 无法解析，请检查格式。"); }
    if (!sameTrustedOperatorItineraryRemovals(product.product, next)) {
      throw new Error("运营删除凭证只能通过每日行程的手动删除操作生成或保留。");
    }
    // A visible, exact slot re-add is an operator change of mind. Revoke only
    // that receipt before validation; raw JSON can never create or alter one.
    clearReappearedTrustedOperatorItineraryRemovals(next);
    parseProduct(next);
    const saved = productMutations.commands.replaceFull({ localProductId: id, source: 'user',
      expectedVersion: product.productJsonVersion ?? 0 }, next, {
      status: productJsonSaveStatus(product.product, next, product.status),
      allowMeetingCityCorrection: true,
      preserveVerifiedItineraryPois: false,
      allowItineraryRemovalRestore: true,
    });
    await reconcileSavedProductQuestion(context, id);
    return saved;
  });

  // Manual review fields are validated against their whitelist and committed
  // together with any research tasks they satisfy.
  ipcMain.handle("products:updateReviewField", async (event, id: string, input: ManualReviewFieldInput) => {
    assertTrustedSender(event, "products:updateReviewField");
    context.productWorkflows.assertIdle(id, "manual");
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    let verifiedInput = input;
    if (input.field === "itinerarySpotPoi") {
      const detail = await context.productWorkflows.runVbkPageExclusive(async () =>
        suggestPoiDetail(await getVbkRequestPage(context.browser), input.poiName, {
          destinationCity: String((product.product.basicInfo as Record<string, unknown> | undefined)?.destinationCity ?? ""),
          province: String((product.product.basicInfo as Record<string, unknown> | undefined)?.province ?? ""),
        }));
      const verifiedPoiInput = verifyManualPoiSelection(product.product, input, detail);
      verifiedInput = verifiedPoiInput;
      const availability = await context.productWorkflows.runVbkPageExclusive(() =>
        getCtripSightAvailability(context.browser, verifiedPoiInput.poiId, db));
      if (availability.status === "suspended") {
        throw new Error(`“${verifiedPoiInput.poiName}”在携程景点详情中标记为${availability.openStatus}，不能加入行程。`);
      }
    }
    const next = applyManualReviewField(product.product, verifiedInput);
    const policy = manualReviewSavePolicy(product.status);
    if (policy.requireCompleteProduct) parseProduct(next);
    const beforeConfirmed = new Set(product.researchTasks.filter(task => task.state === 'confirmed').map(task => task.id));
    const saved = productMutations.commands.manualField({ localProductId: id, source: 'user',
      expectedVersion: product.productJsonVersion ?? 0 }, verifiedInput, { status: policy.nextStatus });
    // 显式人工选定 POI 就是「请手动选择 POI」决策门的运营决策本身：落库后按
    // 持久化行程取证结清同名 task。自动确认谓词仍拒绝把同名 + 正整数 POI ID
    // 当作结清依据，所以这条受控凭证必须在这里补上，否则运营选完 POI 仍会
    // 在待核查列表里看到同一项。
    const manualPoiMapping = verifiedInput.field === "itinerarySpotPoi"
      ? verifiedMappingForManualPoi(saved.product, verifiedInput)
      : null;
    const settledPoiTasks = manualPoiMapping
      ? db.confirmVerifiedPoiResearchTasks(id, [manualPoiMapping])
      : { taskIds: [] as string[] };
    const resultProduct = settledPoiTasks.taskIds.length ? db.getProduct(id) ?? saved : saved;
    const confirmedTaskIds = resultProduct.researchTasks.filter(task => task.state === 'confirmed' && !beforeConfirmed.has(task.id)).map(task => task.id);
    await reconcileSavedProductQuestion(context, id);
    if (confirmedTaskIds.length > 0) {
      logInfo("[products:updateReviewField] sync-confirmed research task", {
        localProductId: id,
        field: verifiedInput.field,
        confirmedTaskIds,
      });
    }
    broadcastProduct(resultProduct);
    emitProduct(resultProduct);
    return resultProduct;
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

  ipcMain.handle("research:accept", async (_event, localProductId: string, taskId: string, note?: string) => {
    db.markResearchAccepted(localProductId, taskId, note);
    const product = await syncConfirmedResearchTasksToRemote({
      db,
      remote: remoteProducts,
      localProductId,
      broadcast: broadcastProduct,
    });
    return { accepted: true, product };
  });
  ipcMain.handle("research:refreshIssues", async (_event, localProductId: string) => {
    const product = db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const result = refreshSatisfiedResearchTasks(db, localProductId);
    const next = shouldSyncConfirmedResearchTasks(result)
      ? await syncConfirmedResearchTasksToRemote({
        db,
        remote: remoteProducts,
        localProductId,
        broadcast: broadcastProduct,
      })
      : db.getProduct(localProductId)!;
    return { ...result, product: next, readiness: readiness(localProductId) };
  });
  ipcMain.handle("research:vehicleResource", (_event, localProductId: string, taskId?: string) =>
    context.productWorkflows.runExclusive(localProductId, "resource", () =>
      context.productWorkflows.runVbkPageExclusive(async () => {
        const product = db.getProduct(localProductId);
        if (!product) throw productNotFound(localProductId);
        const result = await platformResourceGateway(db, localProductId).query('vehicle_groups', product.product.operations,
          async () => resolveVehicleResource(await getVbkRequestPage(context.browser), product));
        productMutations.commands.mergeChanges(localProductId, product, result.product, 'resource', { status: "review", notify: false }, {
          queryPath: ['operations'], queryFingerprint: canonicalJson(product.product.operations),
          targetPath: ['operations', 'vehicleResource'], targetFingerprint: canonicalJson((product.product.operations as Record<string, unknown>)?.vehicleResource),
        });
        if (result.resolved && taskId) {
          await syncConfirmedResearchTasksToRemote({ db, remote: remoteProducts, localProductId, broadcast: broadcastProduct });
        }
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
        const result = await resolveHotelResource(undefined, product);
        productMutations.commands.mergeChanges(localProductId, product, result.product, 'resource', { status: "review", notify: false }, {
          queryPath: ['operations'], queryFingerprint: canonicalJson(product.product.operations),
          targetPath: ['operations', 'hotelResource'], targetFingerprint: canonicalJson((product.product.operations as Record<string, unknown>)?.hotelResource),
        });
        if (taskId) {
          await syncConfirmedResearchTasksToRemote({ db, remote: remoteProducts, localProductId, broadcast: broadcastProduct });
        }
        db.addMessage(localProductId, "assistant", `已配置酒店规则：${result.note}`, "succeeded");
        emitProduct(db.getProduct(localProductId)!);
        return result.resolved;
      })));
}
