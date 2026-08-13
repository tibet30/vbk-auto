import { logInfo, logWarn } from "../../shared/log-timestamp.js";
import type { CreateProductInput, ManualReviewFieldInput } from "../../shared/contracts.js";
import { aiProviderLabel as resolveAiProviderLabel } from "../../shared/ai-provider-config.js";
import { MiniMaxService, MiniMaxServiceError } from "../minimax/minimax.js";
import { parseProduct } from "../automation/schema/schema.js";
import { resolveVehicleResource } from "../operations/vehicle-resource.js";
import { resolveHotelResource } from "../operations/hotel-resource.js";
import { applyAutoCoverFill } from "../operations/cover-auto-fill.js";
import { applyAutoVehicleResourceTrigger } from "../operations/vehicle-resource-trigger.js";
import { applyManualReviewField } from "../operations/manual-review-field.js";
import { refreshSatisfiedResearchTasks } from "../operations/research-refresh.js";
import { createProductWithAccountButler, injectAccountButler } from "../operations/account-butler-inject.js";
import { assertCreatePreconditions } from "../operations/product-create-guard.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import {
  classifyMiniMaxError,
  extractMiniMaxFailureReason,
  normalizeFailureMessage,
  stripRetryHintTail,
  toRetryHint,
} from "../minimax/minimax-error-handling.js";
import type { MainIpcContext } from "./context.js";

export function registerProductAiIpc(context: MainIpcContext): void {
  const { db, emitProduct, readiness, getSettings, aiService, productMutations } = context;
  ipcMain.handle("products:list", () => db.listProducts());
  ipcMain.handle("products:create", (_event, input: CreateProductInput) => {
    // 「产品创建」主进程防线：在写库前硬校验「登录 + 400 电话 + 管家联系人」。
    // 任意一项缺失直接抛错（中文、列出补救路径），不创建产品、不写消息、不写任务，
    // 也不发 product:updated。UI 端的提示只是辅助，这里才是真源。
    assertCreatePreconditions(db);
    // 「管家默认当前账号」：新建产品时若当前已登录 VBK 且账号已配管家，
    // 自动把 butlerName 写入 product.operations.bookingControls.butler。
    // 已有 butler / 未登录 / 未配置 都不会写；写失败也不抛错，避免影响创建。
    const accountName = db.getSetting("vbkAccountName")?.value || null;
    const { product: finalProduct, injectResult } = createProductWithAccountButler(db, input, accountName);
    if (injectResult.written) {
      logInfo("[createProduct] auto-injected butler from current account", { localProductId: finalProduct.id, accountName });
    } else if (injectResult.reason) {
      logInfo("[createProduct] butler not auto-injected", { localProductId: finalProduct.id, reason: injectResult.reason });
    }
    emitProduct(finalProduct);
    // 第一版产品方案的自动触发不在 main 这里走 —— 交给 renderer 端的 useEffect
    // 兑底。main 端 fire-and-forget 的请求与 renderer useEffect 重复触发会同时
    // 生成两条 user-running 消息，状态不一致；renderer 单一入口更可控，
    // 且能同时覆盖“新建后立即触发”与“重开空草稿产品”两种场景。
    return finalProduct;
  });
  ipcMain.handle("products:get", (_event, id: string) => {
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    return product;
  });
  ipcMain.handle("products:delete", (_event, id: string) => {
    const removed = db.deleteProduct(id);
    if (!removed) throw productNotFound(id);
    return { deleted: true };
  });
  ipcMain.handle("products:readiness", (_event, id: string) => readiness(id));
  ipcMain.handle("products:updateProductJson", (_event, id: string, json: string) => {
    context.productWorkflows.assertIdle(id, "manual");
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    let next: Record<string, unknown>;
    try { next = JSON.parse(json); }
    catch { throw new Error("产品 JSON 无法解析，请检查格式。"); }
    parseProduct(next);
    return productMutations.replace(id, next, { status: "review" });
  });
  // 运营人员直接在 UI 上录入的「需要人工复核」字段（例如定价 pricing）。
  // 仅允许 ManualReviewFieldInput 白名单，product 走 schema 校验后才落库；
  // 路径不走 JSON patch，避免与 AI 写入口径混在一起难以追溯。
  //
  // 关键：保存有效 itinerarySpotPoi / productCover 时必须同步把匹配该字段
  // 的 research task 标记为 confirmed，否则持久化层（products:readiness /
  // 自动化 preflight / 重载后 getProduct）会与乐观 UI 出现不一致（100% vs 92%）。
  // 这里走 db.replaceProductAndSatisfyResearchTasks 把 JSON 写入与 task 确认
  // 放在同一个事务里。
  ipcMain.handle("products:updateReviewField", (event, id: string, input: ManualReviewFieldInput) => {
    assertTrustedSender(event, "products:updateReviewField");
    context.productWorkflows.assertIdle(id, "manual");
    const product = db.getProduct(id);
    if (!product) throw productNotFound(id);
    const next = applyManualReviewField(product.product, input);
    parseProduct(next);
    // 原子写入：product JSON 与匹配该字段的 research task 确认同步落库。
    // 详见 src/main/infrastructure/database/parts/replace-product-with-research-tasks.ts。
    const { product: saved, confirmedTaskIds } = db.replaceProductAndSatisfyResearchTasks(id, next, { status: "review" });
    if (confirmedTaskIds.length > 0) {
      logInfo("[products:updateReviewField] sync-confirmed research task", { localProductId: id, field: input.field, confirmedTaskIds });
    }
    return saved;
  });
  // 抽到模块级函数，products:create 会用它做自动触发；调用方决定是否 fire-and-forget。
  // 这里不去做任何"是否第一次"判断 —— 自动触发由调用方按 minimax 已配置 API Key 决定。

  /** 检查产品草稿中是否缺失关键生成模块，返回缺失模块的路径列表。 */
  function detectMissingModules(product: Record<string, unknown>): string[] {
    const missing: string[] = [];
    const p = product.presentation;
    if (!p || typeof p !== "object" || Array.isArray(p)) missing.push("presentation");
    const i = product.itinerary;
    if (!Array.isArray(i) || i.length === 0) missing.push("itinerary");
    const c = product.commercial as Record<string, unknown> | undefined;
    if (!c || typeof c.pricing !== "object" || Array.isArray(c.pricing)) missing.push("commercial/pricing");
    if (!c || typeof c.inventory !== "object" || Array.isArray(c.inventory)) missing.push("commercial/inventory");
    if (!c || typeof c.release !== "object" || Array.isArray(c.release)) missing.push("commercial/release");
    if (!c || typeof c.terms !== "object" || Array.isArray(c.terms)) missing.push("commercial/terms");
    return missing;
  }

  async function runAiReply(localProductId: string, content: string) {
    const product = db.getProduct(localProductId); if (!product) throw productNotFound(localProductId);
    const message = typeof content === "string" ? content.trim() : "";
    if (!message) throw new Error("请输入要发送给 AI 的内容。");
    if (message.length > 6000) throw new Error("单条消息不能超过 6000 个字符，请拆分后发送。");
    const userMessageId = db.addMessage(localProductId, "user", message, "running");
    emitProduct(db.getProduct(localProductId)!);
    // 本轮请求开始时锁定当前 AI 提供商快照：service、过程日志、最终 normalizeFailureMessage
    // 都使用同一份快照，避免请求过程中用户切换模型导致错误归错提供商。
    const turnSettings = getSettings();
    const providerLabel = resolveAiProviderLabel(turnSettings);
    try {
      const history = product.messages.filter((item) => (item.role === "user" || item.role === "assistant") && item.taskStatus !== "failed" && item.taskStatus !== "running");
      const service = await aiService(turnSettings);
      const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary : [];
      const isInitialDraft = !itinerary.length && /生成|第一版|方案/.test(message);
      const retryableCodes = new Set(["provider_connection", "provider_timeout", "provider_error", "provider_rate_limit", "invalid_model_output", "empty_model_output"]);
      const isRetryable = (error: unknown) => {
        const code = classifyMiniMaxError(error);
        return retryableCodes.has(code);
      };
      const maxRetryAttempts = 5;
      let connectionChecked = false;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      let response: Awaited<ReturnType<MiniMaxService["reply"]>> | undefined;
      const repairPrompt = "上一次返回未通过结构化校验，请只返回纯 JSON 对象（仅包含 reply、patch、questions、researchTasks 四个字段），并为该轮返回至少一个可写入的 patch；不得带说明文字。";
      let lastFailureReason = "";
      const trimmedHistory = history.slice(-12);
      const requiresWritablePatch =
        isInitialDraft
        || /继续|补齐|补充|调整|更新|继续生成|继续补充|再次生成|重试|生成/.test(message)
        || /修正|重写|优化|重新/.test(message)
        || message.includes("上一次返回未通过结构化校验");
      for (let attempt = 1; attempt <= maxRetryAttempts; attempt++) {
        if (!connectionChecked) {
          await service.testConnection();
          connectionChecked = true;
        }
        const requestMessage = attempt === 1
          ? message
          : [
            message,
            repairPrompt,
            lastFailureReason ? `上一次返回原因：${lastFailureReason}` : "",
          ]
            .filter((item) => item)
            .join("\n\n");
        const attemptHistory = attempt === 1 ? trimmedHistory : trimmedHistory.slice(-4);
        try {
          response = await service.reply({
            message: requestMessage,
            product: product.product,
            history: attemptHistory.map((item) => ({ role: item.role, content: item.content })),
          });
          break;
          } catch (error) {
          if (attempt >= maxRetryAttempts || !isRetryable(error)) throw error;
          lastFailureReason = toRetryHint(extractMiniMaxFailureReason(error) || ((error as { message?: string })?.message ?? ""));
          try {
            const retryCode = classifyMiniMaxError(error);
            const shouldProbeConnectivity = new Set(["provider_connection", "provider_timeout", "provider_error"]).has(retryCode);
            if (shouldProbeConnectivity) {
              connectionChecked = false;
              logWarn("[AI] planning request failed, run connectivity check before retry", {
                provider: turnSettings.aiProvider,
                attempt,
                errorCode: (error as { code?: string })?.code,
              });
            }
          } catch (probeError) {
            throw probeError;
          }
          await wait(350 * attempt);
        }
      }
      // 如果服务返回空响应兜底，统一按结构化内容异常处理，避免错误地提示网络故障。
      if (!response) {
        throw new MiniMaxServiceError("invalid_model_output", "AI 未返回可写入的产品方案，请重试。");
      }
      const responsePatch = response.patch ?? [];
      const patchResult = responsePatch.length
        ? productMutations.applyAiPatch(localProductId, responsePatch, { notify: false })
        : { product, applied: false };
      if (requiresWritablePatch && (responsePatch.length === 0 || !patchResult.applied)) {
        throw new MiniMaxServiceError("invalid_model_output", "AI 未返回可写入的产品方案，请重试。");
      }
      db.updateMessageStatus(localProductId, userMessageId, "succeeded"); db.addMessage(localProductId, "assistant", response.reply, "succeeded");
      for (const task of response.researchTasks || []) db.addResearchTask(localProductId, task);
      // 首轮生成后自动检查缺失模块：如果 presentation / itinerary / commercial 子模块
      // 仍未写入，追加一轮 AI 调用专门补齐，提升首次生成完整率。
      if (isInitialDraft) {
        const currentProduct = db.getProduct(localProductId)!.product;
        const missingModules = detectMissingModules(currentProduct);
        if (missingModules.length > 0) {
          const missingHint = missingModules.join("、");
          logInfo("[AI] first-draft missing modules detected, automatic follow-up", { provider: turnSettings.aiProvider, missingHint });
          const followUpMsg = `以下模块尚未生成：${missingHint}。请通过 submit_product_update 工具逐个补充这些模块的完整内容，每个模块用独立的 patch 操作。`;
          try {
            const secondResponse = await service.reply({
              message: followUpMsg,
              product: currentProduct,
              history: trimmedHistory.slice(-6).map((item) => ({ role: item.role as "user" | "assistant", content: item.content })),
            });
            const secondPatch = secondResponse.patch ?? [];
            if (secondPatch.length > 0) {
              productMutations.applyAiPatch(localProductId, secondPatch, { notify: false });
            }
            for (const task of secondResponse.researchTasks || []) {
              db.addResearchTask(localProductId, task);
            }
          } catch (e) {
            // 补齐失败不抛错：第一轮产物已经可用（只是不全），用户仍然可以在左侧继续对话补齐。
            logWarn("[AI] completeness follow-up failed, keeping partial draft", { provider: turnSettings.aiProvider, error: (e as { message?: string })?.message ?? "unknown" });
          }
        }
        // 首轮生成后自动补齐 VBK 车辆和酒店资源：如果 VBK 已登录，通过 API
        // 搜索资源库匹配资源组/酒店，自动标记对应的核查任务为已解决。
        if (isInitialDraft) {
          try {
            const status = await context.browser.status();
            if (!status.loggedIn) {
              logInfo("[AI] VBK not logged in, skipping auto resource resolution", { provider: getSettings().aiProvider });
            } else {
              const productAfterAi = db.getProduct(localProductId)!;
              let page: ReturnType<MainIpcContext["browser"]["page"]> | undefined;
              // 懒加载 VBK 页面：只在需要时才获取，避免过早消费 CDP 连接。
              const ensurePage = async () => { if (!page) page = context.browser.page(); return page; };
              // 首轮 post-processing：若 presentation.cover 缺 imageId/imageUrl，
              // 通过 searchCtripLibraryImages 拿一张完整候选自动写回。复用既有
              // cover-ipc 链路；失败只 console.info，不阻塞 ai:send 主流程。
              try {
                const coverOutcome = await applyAutoCoverFill({
                  page: await ensurePage(),
                  product: productAfterAi.product,
                });
                if (coverOutcome.outcome.written) {
                  productMutations.replace(localProductId, coverOutcome.nextProduct, { status: "review", notify: false });
                  logInfo("[AI] auto cover filled from Ctrip library", {
                    provider: getSettings().aiProvider,
                    keyword: coverOutcome.outcome.keyword,
                    imageId: coverOutcome.outcome.imageId,
                  });
                } else {
                  logInfo("[AI] auto cover skipped", {
                    provider: getSettings().aiProvider,
                    reason: coverOutcome.outcome.reason,
                  });
                }
              } catch (e) {
                logInfo("[AI] auto cover fill raised, keeping partial draft", {
                  provider: getSettings().aiProvider,
                  error: (e as { message?: string })?.message ?? "unknown",
                });
              }
              // 车辆资源：触发条件改为基于产品数据（privateTour + 行程天数 +
              // 上车城市 + 尚未匹配），不再依赖 researchTasks 是否存在；若同时存在
              // 用车类 research task，命中后再标记为已解决。real resourceGroupId /
              // resourceGroupName 仍只由 VBK 匹配回填。
              try {
                const vehicleOutcome = await applyAutoVehicleResourceTrigger({
                  page: await ensurePage(),
                  product: db.getProduct(localProductId)!,
                });
                if (vehicleOutcome.outcome.written) {
                  productMutations.replace(localProductId, vehicleOutcome.nextProduct.product, { status: "review", notify: false });
                  if (vehicleOutcome.outcome.resourceGroupId) {
                    for (const task of vehicleOutcome.nextProduct.researchTasks) {
                      if (task.state !== "confirmed" && task.state !== "resolved" && /用车|车辆|资源组|接送|司机/.test(task.label || "")) {
                        db.markResearchAccepted(localProductId, task.id, vehicleOutcome.outcome.reason, "vbk");
                      }
                    }
                    logInfo("[AI] auto vehicle resource resolved", { provider: getSettings().aiProvider, resourceGroupId: vehicleOutcome.outcome.resourceGroupId });
                  } else if (vehicleOutcome.outcome.estimatedDailyCost) {
                    logInfo("[AI] vehicle requested daily cost estimated", {
                      provider: getSettings().aiProvider,
                      estimatedDailyCost: vehicleOutcome.outcome.estimatedDailyCost,
                      reason: vehicleOutcome.outcome.reason,
                    });
                  } else {
                    logInfo("[AI] vehicle resource not found in VBK", {
                      provider: getSettings().aiProvider,
                      reason: vehicleOutcome.outcome.reason,
                    });
                  }
                }
              } catch (e) {
                logInfo("[AI] auto vehicle resource trigger raised, keeping partial draft", {
                  provider: getSettings().aiProvider,
                  error: (e as { message?: string })?.message ?? "unknown",
                });
              }
              // 酒店资源：必须从 db 重新拉取最新 product，覆盖 / 用车的
              // post-processing 已经可能更新过 product；继续读 productAfterAi
              // 会让酒店把那些写入覆盖回旧值。
              const productForHotel = db.getProduct(localProductId)!;
              if (productForHotel.researchTasks.some((t) => t.state !== "confirmed" && t.state !== "resolved" && /酒店|住宿|客栈|民宿/.test(t.label || ""))) {
                try {
                  const hotelResult = await resolveHotelResource(await ensurePage(), productForHotel);
                  productMutations.replace(localProductId, hotelResult.product, { status: "review", notify: false });
                  if (hotelResult.resolved && hotelResult.resolved.source === "vbk") {
                    for (const task of productForHotel.researchTasks) {
                      if (task.state !== "confirmed" && task.state !== "resolved" && /酒店|住宿|客栈|民宿/.test(task.label || "")) {
                        db.markResearchAccepted(localProductId, task.id, hotelResult.note, "vbk");
                      }
                    }
                    logInfo("[AI] auto hotel resource resolved", { provider: getSettings().aiProvider, resourceId: hotelResult.resolved.resourceId });
                  } else {
                    logWarn("[AI] hotel resource not found in VBK", { provider: getSettings().aiProvider, note: hotelResult.note });
                  }
                } catch (e) {
                  logWarn("[AI] auto hotel resource resolution failed", { provider: getSettings().aiProvider, error: (e as { message?: string })?.message ?? "unknown" });
                }
              }
            }
          } catch (e) {
            // 浏览器未就绪，静默跳过。
            logInfo("[AI] browser not ready for auto resource resolution, skipping", { provider: getSettings().aiProvider });
          }
        }
        // 首轮生成完成后补一次管家注入：products:create 已经在创建时尝试过一次，
        // 但用户可能在创建产品时还没登录 VBK；首次 AI 完成后已是登录态，再补一次。
        // 同样遵守「已有 butler 不覆盖」契约，写入失败只 console.info 不抛错。
        const aiAccountName = db.getSetting("vbkAccountName")?.value || null;
        const aiInject = injectAccountButler(db, localProductId, aiAccountName);
        if (aiInject.written) {
          logInfo("[ai:send] auto-injected butler after first draft", { localProductId, accountName: aiAccountName });
        } else if (aiInject.reason) {
          logInfo("[ai:send] butler not auto-injected after first draft", { localProductId, reason: aiInject.reason });
        }
      }
    } catch (error) {
      const reason = extractMiniMaxFailureReason(error) || (error instanceof Error ? error.message : "AI 服务暂时无法完成本次请求。");
      const errorCode = classifyMiniMaxError(error);
      const finalMessage = normalizeFailureMessage(errorCode, reason, providerLabel);
      const finalStructuredMessage = /返回的数据格式无法用于产品方案|MiniMax 返回的数据格式无法用于产品方案/i.test(finalMessage)
        ? stripRetryHintTail(finalMessage)
        : finalMessage;
      db.updateMessageStatus(localProductId, userMessageId, "failed");
      db.addMessage(localProductId, "assistant", `本轮没有获得 AI 回复：${finalStructuredMessage}`, "failed");
    }
    emitProduct(db.getProduct(localProductId)!);
  }
  ipcMain.handle("ai:send", (_event, localProductId: string, content: string) =>
    context.productWorkflows.runExclusive(localProductId, "ai", () => runAiReply(localProductId, content)));
  ipcMain.handle("ai:regenerate", (_event, localProductId: string, field: string) => {
    // 当前 renderer 未调用；保留入口以便运营后期手动触发单字段重生成。
    // 实际重新生成流程仍走 ai:send（运营填写一句自然语言指令 + 上下文），
    // 单独的实现不增加模型 prompt 重复，等有明确需求再补。
    void localProductId; void field;
    throw new Error("AI 字段级重新生成尚未发布，请回到对话面板继续沟通。");
  });
  ipcMain.handle("research:accept", (_event, localProductId: string, taskId: string, note?: string) => {
    db.markResearchAccepted(localProductId, taskId, note);
    emitProduct(db.getProduct(localProductId)!);
    return { accepted: true };
  });
  ipcMain.handle("research:refreshIssues", (_event, localProductId: string) => {
    const product = db.getProduct(localProductId); if (!product) throw productNotFound(localProductId);
    const result = refreshSatisfiedResearchTasks(db, localProductId);
    const next = db.getProduct(localProductId)!;
    emitProduct(next);
    return { ...result, product: next, readiness: readiness(localProductId) };
  });
  ipcMain.handle("research:vehicleResource", (_event, localProductId: string, taskId?: string) =>
    context.productWorkflows.runExclusive(localProductId, "resource", async () => {
    const product = db.getProduct(localProductId); if (!product) throw productNotFound(localProductId);
    const page = await context.browser.page();
    const result = await resolveVehicleResource(page, product);
    productMutations.replace(localProductId, result.product, { status: "review", notify: false });
    if (result.resolved && taskId) db.markResearchAccepted(localProductId, taskId, result.note, "vbk");
    const message = result.resolved
      ? `已完成用车估算和 VBK 资源组匹配：${result.note}`
      : `用车建议价已保留，但 VBK 资源组暂未匹配成功：${result.note}`;
    db.addMessage(localProductId, "assistant", message, result.resolved ? "succeeded" : "failed");
    const next = db.getProduct(localProductId)!;
    emitProduct(next);
    return result.resolved;
  }));
  ipcMain.handle("research:hotelResource", (_event, localProductId: string, taskId?: string) =>
    context.productWorkflows.runExclusive(localProductId, "resource", async () => {
    const product = db.getProduct(localProductId); if (!product) throw productNotFound(localProductId);
    const page = await context.browser.page();
    const result = await resolveHotelResource(page, product);
    productMutations.replace(localProductId, result.product, { status: "review", notify: false });
    if (taskId) db.markResearchAccepted(localProductId, taskId, result.note, "vbk");
    db.addMessage(localProductId, "assistant", `已查询酒店资源：${result.note}`, "succeeded");
    emitProduct(db.getProduct(localProductId)!);
    return result.resolved;
  }));
}
