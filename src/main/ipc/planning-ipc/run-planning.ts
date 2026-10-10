/**
 * planning-ipc.ts 的 runPlanning 主流程：
 *   - 检查 productWorkflows.assertIdle：拒绝并发跑同产品；
 *   - 构造 DbGenerationStateStore / DbOrchestratorRuntime；
 *   - 选定 Planner：默认 OpenAICompatiblePlannerAdapter；completed POI backfill
 *     走 completedPoiBackfillPlanner；
 *   - 调 runPlan → syncProductStatusAfterRunPlan；
 *   - completed 时调 applyCompletedAfterPlanningResult（封面 / 用车后处理）；
 *   - 写 assistant 消息并 emitProduct；
 *   - 异常时转交 handlePreflightFailure。
 *
 * 拆分原因：单函数 ~140 行过长，单独抽出便于单测覆盖 / 复用。
 */

import { PLANNING_STAGES } from "../../../shared/contracts.js";
import type { Planner, PlanningRunResult } from "../../../shared/contracts.js";
import { aiProviderConfig, aiProviderLabel as resolveAiProviderLabel } from "../../../shared/ai-provider-config.js";
import { isProductForm } from "../../../shared/product-form.js";
import { runPlan } from "../../planning/plan-orchestrator.js";
import { hasIncompleteItineraryPois } from "../../planning/poi-enrichment.js";
import { OpenAICompatiblePlannerAdapter, planningTransportOptions } from "../../planning/adapters/openai-compatible-adapter.js";
import { DbGenerationStateStore, DbOrchestratorRuntime } from "../../planning/runtime.js";
import { syncProductStatusAfterRunPlan } from "../../planning/product-status-sync.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import { resolveProductTrafficLineAvailability } from "../../automation/ctrip/traffic-line/planning-availability.js";
import { applyCompletedAfterPlanningResult } from "./postprocess.js";
import type { MainIpcContext } from "../context.js";

export function createRunPlanning(context: MainIpcContext, handlePreflightFailure: (id: string, error: unknown) => PlanningRunResult) {
  const {
    db,
    emitPlanningState,
    completedPoiBackfillPlanner,
    getSettings,
    apiKey,
    aiService,
    productMutations,
  } = context;
  return async function runPlanning(localProductId: string): Promise<PlanningRunResult> {
    // 必须在 try 外拒绝：重复请求不应被 handlePreflightFailure 写成 failed，
    // 更不能覆盖第一条仍在运行的规划状态。
    context.productWorkflows.assertIdle(localProductId, "planning");
    return context.productWorkflows.runExclusive(localProductId, "planning", async () => {
      try {
      const product = db.getProduct(localProductId);
      if (!product) throw productNotFound(localProductId);
      const store = new DbGenerationStateStore(db, emitPlanningState);
      const runtime = new DbOrchestratorRuntime(
        db,
        context.browser,
        productMutations,
        (task) => context.productWorkflows.runVbkPageExclusive(task),
        (id) => resolveProductTrafficLineAvailability({
          db, browser: context.browser, localProductId: id,
          runVbkPageExclusive: (task) => context.productWorkflows.runVbkPageExclusive(task),
          disambiguateStation: async ({ stationSubtype, desired, product: trafficProduct, candidates }) => {
            const outcome = await (await aiService()).disambiguateOption({
              kind: "station",
              stationSubtype,
              desired,
              product: trafficProduct,
              candidates,
              usage: { localProductId: id, stage: "trafficLineStationSelection" },
            });
            return { pickedText: outcome.pickedText, reasoning: outcome.reasoning };
          },
        }),
        async ({ localProductId: poiProductId, desired, product: poiProduct, candidates }) => {
          const outcome = await (await aiService()).disambiguateOption({
            kind: "spot",
            desired,
            product: poiProduct,
            candidates,
            usage: { localProductId: poiProductId, stage: "planningPoiSelection" },
          });
          return { pickedText: outcome.pickedText, confidence: outcome.confidence };
        },
      );
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
          presentationRejectedWords: db.listRejectedPresentationWords(),
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
          productForm: isProductForm(sales.productForm) ? sales.productForm : "privateTour",
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
        await applyCompletedAfterPlanningResult(context, {
          localProductId,
          providerLabel,
        });
      }
      // 消息 taskStatus 必须跟 result.status 走：completed → succeeded，
      // failed / needs_user → failed（旧实现不论 result.status 都写
      // succeeded，会让 recovery strip / 产品消息列表把失败轮误标成功）。
      const replyMessageTaskStatus: "succeeded" | "failed" = result.status === "completed" ? "succeeded" : "failed";
      const replyMessageId = db.addMessage(localProductId, "assistant", result.assistantReply, replyMessageTaskStatus);
      void replyMessageId;
      context.emitProduct(db.getProduct(localProductId)!);
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
  };
}