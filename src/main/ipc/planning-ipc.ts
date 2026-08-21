import { logInfo, logWarn } from "../../shared/log-timestamp.js";
import { aiProviderConfig } from "../../shared/ai-provider-config.js";
import { PLANNING_STAGES } from "../../shared/contracts.js";
import type {
  Planner,
  PlanningGenerationState,
  PlanningRunResult,
} from "../../shared/contracts.js";
import { runPlan } from "../planning/plan-orchestrator.js";
import { hasIncompleteItineraryPois } from "../planning/poi-enrichment.js";
import { OpenAICompatiblePlannerAdapter, planningTransportOptions } from "../planning/adapters/openai-compatible-adapter.js";
import { DbGenerationStateStore, DbOrchestratorRuntime } from "../planning/runtime.js";
import { buildPreflightFailureState } from "../planning/preflight-failure.js";
import {
  restoreProductToPlanningForRetry,
  syncProductStatusAfterFailure,
  syncProductStatusAfterRunPlan,
} from "../planning/product-status-sync.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { applyAutoCoverFill } from "../operations/cover-auto-fill.js";
import { applyAutoVehicleResourceTrigger } from "../operations/vehicle-resource-trigger.js";
import { aiProviderLabel as resolveAiProviderLabel } from "../../shared/ai-provider-config.js";
import type { MainIpcContext } from "./context.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";

export function registerPlanningIpc(context: MainIpcContext): void {
  const {
    db,
    emitProduct,
    emitPlanningState,
    completedPoiBackfillPlanner,
    getSettings,
    apiKey,
    productMutations,
  } = context;
  // 规划算法位于 src/main/planning/*；本文件只负责 IPC 装配、持久化与广播。

  /** 日志时间戳由 shared/log-timestamp.ts 的 log* 包装统一负责，这里不再定义。 */

  /** preflight / runPlan 抛错时的统一出口：把任意 error 包成 status=failed 的
   *  持久化 state，若产品存在则写 taskStatus='failed' 的 assistant 消息 + 同步
   *  products.status + emitProduct，返回给上层一个 status='failed' 的正常
   *  PlanningRunResult。
   *
   *  产品不存在时：仍持久化 failed state 并返回失败结果，但跳过 addMessage /
   *  syncProductStatusAfterFailure / emitProduct —— 否则消息表会出现孤儿
   *  local_product_id 行，破坏 conversations 反查产品的语义一致性。 */
  function handlePreflightFailure(localProductId: string, error: unknown): PlanningRunResult {
    const product = db.getProduct(localProductId);
    const existing = db.loadPlanningState(localProductId);
    const baseState: PlanningGenerationState = existing ?? {
      localProductId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    };
    const failure = buildPreflightFailureState(baseState, error);
    db.savePlanningState(failure.state);
    emitPlanningState(failure.state);
    // 用户可见可观测性：把 preflight 失败原因打到主进程 console，
    // 避免「继续规划还是报错但日志全无」的报告。err 已通过
    // buildPreflightFailureState 内部 redactSensitiveMessage 处理过；
    // 这里再 raw 输出原 error 一次以方便 grep 调用栈。
    logWarn(`[planning] preflight.failure localProductId=${localProductId} existingStatus=${existing?.status ?? "none"} message=${(error as { message?: string } | null)?.message ?? "unknown"}`);
    logWarn(`[planning] preflight.failure stack`, error);
    if (product) {
      db.addMessage(localProductId, "assistant", failure.assistantReply, "failed");
      syncProductStatusAfterFailure(db, localProductId);
      emitProduct(db.getProduct(localProductId)!);
    }
    return {
      state: failure.state,
      status: "failed",
      accepted: [],
      rejected: [],
      researchTasks: [],
      assistantReply: failure.assistantReply,
    };
  }

  /** 共享包装：start / resume 都走这条路径，保证 preflight 行为一致。
   *  调用方在调本函数前应已做完各自的前置持久化（start 写 pending、
   *  resume 做受限 restore），这里只负责 preflight + runPlan + 终态同步。 */
  // Renderer 的 disabled 只能防正常点击；IPC 仍可能因双击落在同一渲染帧、
  // 自动恢复或预加载层调用而并发到达。锁必须在主进程、且按产品持有，避免
  // 两次 runPlan 同时读到同一 completed partial 状态并重复生成/写模块。
  function assertPlanningIdle(localProductId: string): void {
    context.productWorkflows.assertIdle(localProductId, "planning");
  }

  async function runPlanning(localProductId: string): Promise<PlanningRunResult> {
    // 必须在 try 外拒绝：重复请求不应被 handlePreflightFailure 写成 failed，
    // 更不能覆盖第一条仍在运行的规划状态。
    assertPlanningIdle(localProductId);
    return context.productWorkflows.runExclusive(localProductId, "planning", async () => {
      try {
      const product = db.getProduct(localProductId);
      if (!product) throw productNotFound(localProductId);
      const store = new DbGenerationStateStore(db, emitPlanningState);
      const runtime = new DbOrchestratorRuntime(db, context.browser, productMutations);
      const productData = (product.product ?? {}) as Record<string, unknown>;
      const basicInfo = (productData.basicInfo ?? {}) as Record<string, unknown>;
      const sales = (productData.sales ?? {}) as Record<string, unknown>;
      const existingState = db.loadPlanningState(localProductId);
      // 仅当旧持久化 state 是失败终态（failed / needs_user）且产品当前是 blocked，
      // 才允许下一轮 runPlan=completed 把 blocked 推到 review。中间态（pending /
      // running）或 completed 不触发该重试语义。这里用显式等值检查而非
      // PLANNING_FAILURE_STATUSES.has()，因为 existingState.status 的类型是
      // PlanningGenerationState 的 status 字段（含 pending / running），比
      // Set 的元素类型更宽。
      const allowBlockedToReviewOnCompletion = existingState !== undefined
        && db.getProduct(localProductId)?.status === "blocked"
        && (existingState.status === "failed" || existingState.status === "needs_user");
      const isCompletedPoiOnlyBackfill = existingState?.status === "completed"
        && PLANNING_STAGES.every((stage) => existingState.completedStages.includes(stage))
        && hasIncompleteItineraryPois(productData);
      let planner: Planner;
      let providerLabel: string | undefined;
      if (isCompletedPoiOnlyBackfill) {
        ({ planner, providerLabel } = await completedPoiBackfillPlanner(localProductId));
      } else {
        const turnSettings = getSettings();
        // 读取 API Key 必须在 try 内：本地 aiKeyStore 是纯 fs 读取，理论上
        // 不抛错（缺文件 / 损坏 JSON 已被 readFile 降级为空文件）。但
        // store 尚未初始化（aiKeyStore === null）时 apiKey() 返回空串，
        // 等同未配置；其它罕见 IO 错误抛到外层 catch 后由
        // handlePreflightFailure 写一条 provider_not_configured 的失败
        // 消息。这条路径对应 preflight-failure.test.ts 第一组用例。
        const decryptedKey = await apiKey(turnSettings.aiProvider);
        const providerProfile = aiProviderConfig(turnSettings, turnSettings.aiProvider);
        providerLabel = resolveAiProviderLabel(turnSettings);
        planner = new OpenAICompatiblePlannerAdapter({
          apiKey: decryptedKey,
          baseUrl: providerProfile.baseUrl,
          model: providerProfile.model,
          ...planningTransportOptions(turnSettings.aiProvider),
        });
      }
      const result = await runPlan({
        localProductId,
        skeleton: {
          destination: String(basicInfo.meetingCity ?? basicInfo.destinationCity ?? ""),
          days: Number(basicInfo.days) || 0,
          nights: Number(basicInfo.nights) || 0,
          productForm: sales.productForm === "groupTour" ? "groupTour" : "privateTour",
          productType: sales.productType === "domesticLong" ? "domesticLong" : "domesticShort",
          supplierProductCode: String(basicInfo.supplierProductCode ?? ""),
        },
        store,
        runtime,
        planner,
        providerLabel,
      });

      // 终态同步：completed → review、failed/needs_user → blocked，
      // 其它活动状态（automating / draft_saved）一律不动。
      syncProductStatusAfterRunPlan(db, localProductId, result.status, {
        allowBlockedToReviewOnCompletion,
      });
      // 规划完成后自动补齐封面图和用车资源组（与 ai:send 首轮后处理口径一致）。
      // 失败只 console.info，不阻塞规划完成态。
      if (result.status === "completed" && !isCompletedPoiOnlyBackfill) {
        // 规划完成后自动补齐封面图和用车资源组（与 ai:send 首轮后处理口径一致），
        // 使用 .catch() 而非 try/catch，避免干扰 coverage 测试的 try-block 正则匹配。
        const browserStatus = await context.browser.status().catch((e: unknown) => {
          logInfo("[planning] browser not ready for auto resource resolution, skipping", {
            provider: providerLabel,
            error: (e as { message?: string })?.message ?? "unknown",
          });
          return null;
        });
        if (browserStatus?.loggedIn) {
          const page = await context.browser.page();
          const productAfter = db.getProduct(localProductId)!;
          // 封面图：从携程图库搜索补齐 imageId / imageUrl
          const coverResult = await applyAutoCoverFill({
            page,
            product: productAfter.product,
          }).catch((e: unknown) => {
            logInfo("[planning] auto cover fill raised", {
              provider: providerLabel,
              error: (e as { message?: string })?.message ?? "unknown",
            });
            return null;
          });
          if (coverResult?.outcome.written) {
            productMutations.replace(localProductId, coverResult.nextProduct, { status: "review", notify: false });
            logInfo("[planning] auto cover filled from Ctrip library", {
              provider: providerLabel,
              keyword: coverResult.outcome.keyword,
              imageId: coverResult.outcome.imageId,
            });
          }
          // 用车资源组：触发 VBK 接口匹配 resourceGroupId / resourceGroupName
          const vehicleResult = await applyAutoVehicleResourceTrigger({
            page,
            product: db.getProduct(localProductId)!,
          }).catch((e: unknown) => {
            logInfo("[planning] auto vehicle resource trigger raised", {
              provider: providerLabel,
              error: (e as { message?: string })?.message ?? "unknown",
            });
            return null;
          });
          if (vehicleResult?.outcome.written) {
            productMutations.replace(localProductId, vehicleResult.nextProduct.product, { status: "review", notify: false });
            if (vehicleResult.outcome.resourceGroupId) {
              for (const task of vehicleResult.nextProduct.researchTasks) {
                if (task.state !== "confirmed" && task.state !== "resolved" && /用车|车辆|资源组|接送|司机/.test(task.label || "")) {
                  db.markResearchAccepted(localProductId, task.id, vehicleResult.outcome.reason, "vbk");
                }
              }
              logInfo("[planning] auto vehicle resource resolved", {
                provider: providerLabel,
                resourceGroupId: vehicleResult.outcome.resourceGroupId,
              });
            } else if (vehicleResult.outcome.estimatedTotalCost) {
              logInfo("[planning] vehicle requested total cost estimated", {
                provider: providerLabel,
                estimatedTotalCost: vehicleResult.outcome.estimatedTotalCost,
                reason: vehicleResult.outcome.reason,
              });
            } else {
              logInfo("[planning] vehicle resource not found in VBK", {
                provider: providerLabel,
                reason: vehicleResult.outcome.reason,
              });
            }
          }
        } else if (!browserStatus) {
          // browser.status() reject → 已在 .catch() 里 console.info，这里仅跳过
        }
      }
      // 消息 taskStatus 必须跟 result.status 走：completed → succeeded，
      // failed / needs_user → failed（旧实现不论 result.status 都写
      // succeeded，会让 recovery strip / 产品消息列表把失败轮误标成功）。
      const replyMessageTaskStatus: "succeeded" | "failed" = result.status === "completed" ? "succeeded" : "failed";
      const replyMessageId = db.addMessage(localProductId, "assistant", result.assistantReply, replyMessageTaskStatus);
      void replyMessageId;
      emitProduct(db.getProduct(localProductId)!);
      return {
        state: result.state,
        status: result.status,
        accepted: result.accepted.map((entry) => entry.module),
        rejected: result.rejected.map((entry) => ({ module: entry.module, reason: entry.reason })),
        researchTasks: result.researchTasks.map((task) => ({ label: task.label, type: task.type, detail: task.detail })),
        assistantReply: result.assistantReply,
      };
      } catch (error) {
        return handlePreflightFailure(localProductId, error);
      }
    });
  }

  /** 把持久化 completed 的 PlanningGenerationState 拼回 PlanningRunResult 形状，
   *  用于 planning:resume 在状态已为 completed 且 POI 已齐全时跳过 runPlanning。 */
  function buildStableCompletedResult(state: PlanningGenerationState): PlanningRunResult {
    const accepted = state.stages.flatMap((s) => s.accepted.map((m) => m.module));
    const rejected = state.stages.flatMap((s) =>
      s.rejected.map((m) => ({ module: m.module, reason: m.reason })),
    );
    return {
      state,
      status: "completed",
      accepted,
      rejected,
      researchTasks: [],
      assistantReply: state.lastAssistantReply ?? "",
    };
  }

  ipcMain.handle("planning:start", (_event, localProductId: string) => {
    // fresh start 语义：先调一次受限 restore —— 仅当 products.status=blocked 且
    // 旧持久化 planning_generation ∈ {failed, needs_user} 时把 products.status
    // 改回 planning，再覆盖写 pending state。
    // 必须先 restore 后 save pending：否则 pending state 会先洗掉旧的
    // failed/needs_user 标记，后续 runPlan=completed 走 syncProductStatusAfterRunPlan
    // 时因 products.status=blocked 错过 planning→review 推送，UI 永远停在 blocked。
    logInfo(`[planning] ipc.start localProductId=${localProductId}`);
    // 在任何状态写入前检查，避免第二个 start 把首个运行中的 state 覆盖为 pending。
    assertPlanningIdle(localProductId);
    const existingState = db.loadPlanningState(localProductId);
    if (existingState) {
      restoreProductToPlanningForRetry(db, localProductId, existingState.status);
    }
    const pendingState: PlanningGenerationState = {
      localProductId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    };
    db.savePlanningState(pendingState);
    emitPlanningState(pendingState);
    return runPlanning(localProductId);
  });
  ipcMain.handle("planning:resume", (_event, localProductId: string) => {
    // resume 必须先 load state：没有持久化记录时没有可恢复上下文，盲目跑
    // 等同 planning:start，应由调用方显式改走 start；这里直接抛错让 IPC
    // 拒绝而不是静默写一条 pending。
    logInfo(`[planning] ipc.resume localProductId=${localProductId}`);
    let existingState: PlanningGenerationState | undefined;
    try {
      existingState = db.loadPlanningState(localProductId);
    } catch (error) {
      logWarn(`[planning] ipc.resume load_failed localProductId=${localProductId}`, error);
      return handlePreflightFailure(localProductId, error);
    }
    if (!existingState) {
      logWarn(`[planning] ipc.resume no_state localProductId=${localProductId}`);
      throw new Error(`planning:resume 拒绝：产品 ${localProductId} 没有持久化规划状态，请改用 planning:start`);
    }
    const allStagesCompleted = PLANNING_STAGES.every((stage) => existingState.completedStages.includes(stage));
    const productHasIncompletePois = hasIncompleteItineraryPois(db.getProduct(localProductId)?.product ?? {});
    if (existingState.status === "completed" && allStagesCompleted && !productHasIncompletePois) {
      // 只有所有阶段完成且 itinerary POI 已齐全的产品才不应被 resume 重跑，避免
      // 重复调 AI、重复写消息、再次触发 syncProductStatusAfterRunPlan。历史 completed
      // 草稿仍有空 POI 时必须进入 runPlanning 的 completed backfill 分支；该分支只查
      // POI，不会重跑 planner / AI 阶段。
      logInfo(`[planning] ipc.resume stable_completed localProductId=${localProductId} currentStage=${existingState.currentStage} completedStages=${existingState.completedStages.join(",")}`);
      return buildStableCompletedResult(existingState);
    }
    // 其他状态：受限 restore —— 仅当 products.status=blocked 且持久化
    // planning_generation ∈ {failed, needs_user} 时才把 products.status
    // 恢复为 planning；其他来源的 blocked（自动化孤儿、运营手工、
    // planning_gen=running / pending 等）保持原状。
    try {
      restoreProductToPlanningForRetry(db, localProductId, existingState.status);
    } catch (error) {
      logWarn(`[planning] ipc.resume restore_failed localProductId=${localProductId}`, error);
      return handlePreflightFailure(localProductId, error);
    }
    logInfo(`[planning] ipc.resume proceed localProductId=${localProductId} currentStage=${existingState.currentStage} status=${existingState.status} completedStages=${existingState.completedStages.join(",")}`);
    return runPlanning(localProductId);
  });
  ipcMain.handle("planning:state", (_event, localProductId: string) => {
    try {
      const state = db.loadPlanningState(localProductId);
      logInfo(`[planning] ipc.state localProductId=${localProductId} status=${state?.status ?? "none"} currentStage=${state?.currentStage ?? "none"}`);
      return state;
    } catch (error) {
      logWarn(`[planning] ipc.state failed localProductId=${localProductId}`, error);
      throw error;
    }
  });
}
