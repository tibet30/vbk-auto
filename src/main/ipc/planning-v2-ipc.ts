import { aiProviderConfig, aiProviderLabel } from "../../shared/ai-provider-config.js";
import type {
  PlanningGenerationState,
  PlanningMajorStage,
  PlanningPlanV2,
  PlanningRunResult,
  PlanningStage,
  ProductDetail,
} from "../../shared/contracts.js";
import { applyAutoCoverFill, isCtripLibraryCoverComplete } from "../operations/cover-auto-fill.js";
import { applyAutoVehicleResourceTrigger } from "../operations/vehicle-resource-trigger.js";
import { OpenAICompatiblePlannerAdapter, planningTransportOptions } from "../planning/adapters/openai-compatible-adapter.js";
import { OpenAIThreeStagePlanningAi } from "../planning/adapters/three-stage-ai.js";
import { DbOrchestratorRuntime } from "../planning/runtime.js";
import { invalidatePlanningStage, resetProductForPlanningStage } from "../planning/planning-v2-reset.js";
import { createPlanningPlanV2, runThreeStagePlan } from "../planning/three-stage-orchestrator.js";
import { acceptItineraryAndRerunCompletion } from "../planning/itinerary-adoption-flow.js";
import { suggestPoiDetail } from "../infrastructure/poi-suggest.js";
import { searchCtripLibraryImages } from "../infrastructure/ctrip-library-search.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import type { MainIpcContext } from "./context.js";

export function registerPlanningV2Ipc(context: MainIpcContext): void {
  const acceptingItineraries = new Set<string>();
  const runBody = async (localProductId: string, initialPlan?: PlanningPlanV2): Promise<PlanningRunResult> => {
      let remote = await context.remoteProducts.get(localProductId);
      context.db.importProductSnapshot(remote);
      const product = remote.product;
      const basic = asRecord(product.basicInfo);
      const sales = asRecord(product.sales);
      if (!basic || !sales) throw new Error("产品骨架缺少 basicInfo 或 sales，无法规划。");
      const destination = text(basic.destination) || text(basic.destinationCity) || text(basic.meetingCity);
      const province = text(basic.province);
      const destinationCity = text(basic.destinationCity) || destination;
      const days = Number(basic.days);
      if (!destination || !Number.isInteger(days) || days < 1) {
        throw new Error("产品骨架准入失败：原始目的地或天数无效。");
      }
      const turnSettings = context.getSettings();
      const provider = aiProviderConfig(turnSettings, turnSettings.aiProvider);
      const key = await context.apiKey(turnSettings.aiProvider);
      if (!key) throw new Error(`请先配置${aiProviderLabel(turnSettings)} API Key。`);
      const transport = planningTransportOptions(turnSettings.aiProvider);
      const plannerConfig = {
        apiKey: key,
        baseUrl: provider.baseUrl,
        model: provider.model,
        ...transport,
        provider: aiProviderLabel(turnSettings),
      };
      const planner = new OpenAICompatiblePlannerAdapter(plannerConfig);
      const threeStageAi = new OpenAIThreeStagePlanningAi(plannerConfig);
      const runtime = new DbOrchestratorRuntime(context.db, context.browser, context.productMutations);
      const skeleton = {
        destination,
        province,
        city: destinationCity,
        days,
        nights: Number(basic.nights) || Math.max(0, days - 1),
        productForm: sales.productForm === "groupTour" ? "groupTour" as const : "privateTour" as const,
        productType: sales.productType === "domesticLong" ? "domesticLong" as const : "domesticShort" as const,
        supplierProductCode: text(basic.supplierProductCode),
      };
      const persist = async (plan: PlanningPlanV2) => {
        const local = context.db.getProduct(localProductId);
        if (!local) throw productNotFound(localProductId);
        const status: ProductDetail["status"] = plan.status === "completed"
          ? "review"
          : plan.status === "needs_user" || plan.status === "failed"
            ? "blocked"
            : "planning";
        const snapshot: ProductDetail = {
          ...remote,
          ...local,
          status,
          revision: remote.revision,
          planning: plan,
          updatedAt: new Date().toISOString(),
        };
        if (!remote.revision) throw new Error("Tibet 产品缺少 revision，无法安全保存规划节点。");
        remote = await context.remoteProducts.update(snapshot, remote.revision);
        context.db.importProductSnapshot(remote);
        context.broadcastProduct(remote);
        context.emitPlanningState(toLegacyState(remote.id, plan));
      };

      const assertVbkLogin = async () => {
        const login = await context.browser.status(true);
        if (!login.loggedIn) throw new Error(login.message || "VBK 登录已失效，请重新登录后继续规划。");
        if (!login.accountName?.trim() && !login.loginAccount?.trim()) {
          throw new Error("VBK 登录账号无法识别，请重新登录后继续规划。");
        }
      };

      const plan = await runThreeStagePlan({
        localProductId,
        skeleton,
        planner,
        ai: threeStageAi,
        runtime,
        initialPlan,
        persist,
        assertVbkLogin,
        privateTour: skeleton.productForm === "privateTour",
        providerLabel: plannerConfig.provider,
        queryPoi: async (name) => suggestPoiDetail(await context.browser.page(), name, {
          destinationCity: skeleton.city,
          province: skeleton.province,
        }),
        resolveCover: async () => {
          let current = context.db.getProduct(localProductId);
          if (!current) throw productNotFound(localProductId);
          const preparedProduct = ensureCoverUsesFinalItineraryPoi(current.product);
          if (preparedProduct !== current.product) {
            current = context.productMutations.replace(localProductId, preparedProduct, { notify: false });
          }
          const cover = asRecord(asRecord(current.product.presentation)?.cover);
          if (isCtripLibraryCoverComplete(cover)) return { complete: true, summary: "真实封面 imageId + imageUrl 已存在" };
          const result = await applyAutoCoverFill({
            page: await context.browser.page(),
            product: current.product,
            injectSearch: async (page, keyword) => {
              await assertVbkLogin();
              return searchCtripLibraryImages(page, keyword);
            },
          });
          if (result.outcome.written) {
            const latest = context.db.getProduct(localProductId);
            if (!latest) throw productNotFound(localProductId);
            const nextProduct = structuredClone(latest.product);
            const latestPresentation = asRecord(nextProduct.presentation) ?? {};
            const resultPresentation = asRecord(result.nextProduct.presentation) ?? {};
            const resultCover = asRecord(resultPresentation.cover);
            if (resultCover) latestPresentation.cover = resultCover;
            nextProduct.presentation = latestPresentation;
            context.productMutations.replace(localProductId, nextProduct, { notify: false });
          }
          const nextCover = asRecord(asRecord(result.nextProduct.presentation)?.cover);
          return {
            complete: isCtripLibraryCoverComplete(nextCover),
            summary: result.outcome.written ? `已匹配真实封面 imageId ${result.outcome.imageId}` : result.outcome.reason,
          };
        },
        resolveVehicle: async () => {
          let current = context.db.getProduct(localProductId);
          if (!current) throw productNotFound(localProductId);
          const requested = asRecord(asRecord(current.product.operations)?.vehicleResource);
          if (!(typeof requested?.requestedTotalCost === "number" && requested.requestedTotalCost > 0)) {
            const amount = await threeStageAi.estimateVehicleTotalCost({
              destination: skeleton.destination,
              province: skeleton.province,
              city: skeleton.city,
              days,
              itinerary: Array.isArray(current.product.itinerary) ? current.product.itinerary : [],
            });
            const next = structuredClone(current.product);
            const operations = asRecord(next.operations) ?? {};
            operations.vehicleResource = { ...(asRecord(operations.vehicleResource) ?? {}), requestedTotalCost: amount };
            next.operations = operations;
            current = context.productMutations.replace(localProductId, next, { notify: false });
          }
          const result = await applyAutoVehicleResourceTrigger({ page: await context.browser.page(), product: current });
          if (result.outcome.written) {
            const latest = context.db.getProduct(localProductId);
            if (!latest) throw productNotFound(localProductId);
            const nextProduct = structuredClone(latest.product);
            const latestOperations = asRecord(nextProduct.operations) ?? {};
            const resultOperations = asRecord(result.nextProduct.product.operations) ?? {};
            const resultVehicleResource = asRecord(resultOperations.vehicleResource);
            if (resultVehicleResource) latestOperations.vehicleResource = resultVehicleResource;
            nextProduct.operations = latestOperations;
            context.productMutations.replace(localProductId, nextProduct, { notify: false });
          }
          const resource = asRecord(asRecord(result.nextProduct.product.operations)?.vehicleResource);
          const complete = positiveInteger(resource?.resourceGroupId) && Boolean(text(resource?.resourceGroupName));
          return {
            complete,
            summary: complete
              ? `已匹配 ${text(resource?.resourceGroupName)}（${resource?.resourceGroupId}）`
              : result.outcome.reason,
          };
        },
      });
    return toRunResult(localProductId, plan);
  };

  // 读取、重置/更新和实际运行必须处于同一把产品锁内。仅在 handler 顶部
  // assertIdle 会留下「检查后、mutation 前」的 await 竞态，第二个请求仍可能
  // 先覆盖第一个请求的 pending/invalidated 数据；runBody 不再重复加锁。
  const withPlanningLock = <T>(localProductId: string, task: () => Promise<T>): Promise<T> => {
    context.productWorkflows.assertIdle(localProductId, "planning");
    return context.productWorkflows.runExclusive(localProductId, "planning", task);
  };

  const run = (localProductId: string, initialPlan?: PlanningPlanV2): Promise<PlanningRunResult> =>
    withPlanningLock(localProductId, () => runBody(localProductId, initialPlan));

  ipcMain.handle("planning:start", async (_event, localProductId: string) => {
    return withPlanningLock(localProductId, async () => {
      const remote = await context.remoteProducts.get(localProductId);
      if (!remote.revision) throw new Error("Tibet 产品缺少 revision，无法安全开始规划。");
      const plan = createPlanningPlanV2();
      const prepared = await context.remoteProducts.update({
        ...remote,
        product: resetProductForPlanningStage(remote.product, "foundation"),
        status: "planning",
        planning: plan,
        updatedAt: new Date().toISOString(),
      }, remote.revision);
      context.db.importProductSnapshot(prepared);
      context.broadcastProduct(prepared);
      return runBody(localProductId, plan);
    });
  });

  ipcMain.handle("planning:resume", async (_event, localProductId: string) => {
    return withPlanningLock(localProductId, async () => {
      const remote = await context.remoteProducts.get(localProductId);
      if (!remote.planning || remote.planning.version !== 2) throw new Error("该产品没有可恢复的新流程规划，请重新开始规划。");
      if (remote.planning.itineraryAdoption?.status === "pending" || remote.planning.itineraryAdoption?.status === "blocked") {
        throw new Error("当前有一版对话行程待采用，请先点击“采用此行程并重新补全产品”。");
      }
      if (remote.planning.status === "completed") return toRunResult(localProductId, remote.planning);
      return runBody(localProductId, remote.planning);
    });
  });

  ipcMain.handle("planning:state", async (_event, localProductId: string) => {
    const remote = await context.remoteProducts.get(localProductId);
    return remote.planning?.version === 2 ? toLegacyState(localProductId, remote.planning) : undefined;
  });

  ipcMain.handle("planning:rerunMajorStage", async (_event, localProductId: string, stage: PlanningMajorStage) => {
    if (!(["foundation", "itinerary", "completion"] as string[]).includes(stage)) throw new Error("未知的规划阶段。");
    return withPlanningLock(localProductId, async () => {
      const remote = await context.remoteProducts.get(localProductId);
      if (!remote.revision) throw new Error("Tibet 产品缺少 revision，无法安全重做规划阶段。");
      const plan = invalidatePlanningStage(remote.planning, stage);
      const prepared = await context.remoteProducts.update({
        ...remote,
        product: resetProductForPlanningStage(remote.product, stage),
        status: "planning",
        planning: plan,
        updatedAt: new Date().toISOString(),
      }, remote.revision);
      context.db.importProductSnapshot(prepared);
      context.broadcastProduct(prepared);
      return runBody(localProductId, plan);
    });
  });

  ipcMain.handle("planning:acceptItineraryAndRerunCompletion", async (_event, localProductId: string) => {
    return withPlanningLock(localProductId, () =>
      acceptItineraryAndRerunCompletion({ context, localProductId, accepting: acceptingItineraries, run: runBody }));
  });
}

const NODE_TO_STAGE: Record<string, PlanningStage> = {
  skeleton: "skeleton",
  spotCandidates: "itinerary",
  poiResolution: "itinerary",
  itineraryDraft: "itinerary",
  copy: "basicInfo",
  presentation: "presentation",
  commercial: "commercial",
  cover: "research",
  vehicleResource: "research",
  finalValidation: "validation",
};

export function toLegacyState(localProductId: string, plan: PlanningPlanV2): PlanningGenerationState {
  const completed = new Set<PlanningStage>();
  for (const item of plan.nodes) {
    if (item.status === "completed" || item.status === "skipped") completed.add(NODE_TO_STAGE[item.id]);
  }
  return {
    localProductId,
    currentStage: NODE_TO_STAGE[plan.currentNode],
    completedStages: [...completed],
    stages: [],
    status: plan.status,
    resumeAt: plan.updatedAt,
  };
}

function toRunResult(localProductId: string, plan: PlanningPlanV2): PlanningRunResult {
  const state = toLegacyState(localProductId, plan);
  return {
    state,
    status: plan.status === "completed" ? "completed" : plan.status === "failed" ? "failed" : "needs_user",
    accepted: [],
    rejected: plan.nodes.filter((node) => node.status === "failed" || node.status === "blocked").map((node) => ({ module: "researchTasks", reason: node.error })),
    researchTasks: [],
    assistantReply: plan.status === "completed" ? "三阶段产品规划已完成，已进入产品审查。" : "规划已暂停，请在规划树中查看失败节点。",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function ensureCoverUsesFinalItineraryPoi(product: Record<string, unknown>): Record<string, unknown> {
  const names: string[] = [];
  for (const day of Array.isArray(product.itinerary) ? product.itinerary : []) {
    const spots = Array.isArray(asRecord(day)?.spots) ? asRecord(day)!.spots as unknown[] : [];
    for (const spot of spots) {
      const name = text(asRecord(spot)?.poiName) || text(asRecord(spot)?.name);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  if (names.length === 0) throw new Error("最终行程没有可用于封面的真实 POI。");
  const presentation = asRecord(product.presentation) ?? {};
  const cover = asRecord(presentation.cover);
  if (cover?.source === "ctripLibrary" && names.includes(text(cover.poi))) return product;
  const description = text(cover?.description) || text(presentation.features) || text(presentation.recommendation) || `${names[0]}行程封面`;
  return {
    ...product,
    presentation: {
      ...presentation,
      cover: { source: "ctripLibrary", poi: names[0], description: description.slice(0, 100), minQuality: 3 },
    },
  };
}
