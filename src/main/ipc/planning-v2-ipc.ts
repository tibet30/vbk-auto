import type {
  AgentSnapshot,
  PlanningGenerationState,
  PlanningMajorStage,
  PlanningPlanV2,
  PlanningRunResult,
  PlanningStage,
} from "../../shared/contracts.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { MainIpcContext } from "./context.js";

export function registerPlanningV2Ipc(context: MainIpcContext): void {
  const requireAgent = () => {
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    return context.agentCore;
  };

  // Released renderers still expect PlanningRunResult from these channels.
  // Each mutation is expressed as an Agent intent so there is only one loop.
  const toCompatibleResult = (localProductId: string, snapshot: AgentSnapshot): PlanningRunResult => {
    const product = context.db.getProduct(localProductId);
    const state = product?.planning?.version === 2
      ? toLegacyState(localProductId, product.planning)
      : {
          localProductId,
          currentStage: "skeleton" as const,
          completedStages: [],
          stages: [],
          status: snapshot.run?.status === "failed" ? "failed" as const : "pending" as const,
          resumeAt: snapshot.run?.updatedAt ?? new Date().toISOString(),
        };
    const status = snapshot.run?.status === "completed" ? "completed" as const
      : snapshot.run?.status === "failed" ? "failed" as const
        : "needs_user" as const;
    return {
      state,
      status,
      accepted: [],
      rejected: [],
      researchTasks: [],
      assistantReply: status === "failed"
        ? snapshot.run?.error ?? "Agent 未能启动规划。"
        : "规划请求已交给 Agent，进度会在任务中心持续更新。",
    };
  };

  const sendPlanningIntent = async (localProductId: string, content: string): Promise<PlanningRunResult> => {
    const snapshot = await requireAgent().send(localProductId, content);
    context.emitAgentSnapshot?.(snapshot);
    return toCompatibleResult(localProductId, snapshot);
  };

  const runPlanningIntent = async (localProductId: string, mode: "start" | "resume"): Promise<PlanningRunResult> => {
    const agent = requireAgent();
    const current = mode === "resume" ? await agent.get(localProductId) : undefined;
    if (mode === "resume" && current?.run && !["completed", "abandoned"].includes(current.run.status)) {
      const snapshot = await agent.resume(localProductId);
      context.emitAgentSnapshot?.(snapshot);
      return toCompatibleResult(localProductId, snapshot);
    }
    return sendPlanningIntent(localProductId, mode === "start"
      ? "请基于当前产品开始规划。先读取产品和必要资源；有写入前请求明确审批。"
      : "请继续当前产品规划。先读取已有状态，不要重置或重复已验证内容。");
  };

  ipcMain.handle("planning:start", (_event, localProductId: string) =>
    runPlanningIntent(localProductId, "start"));
  ipcMain.handle("planning:resume", (_event, localProductId: string) =>
    runPlanningIntent(localProductId, "resume"));

  ipcMain.handle("planning:state", async (_event, localProductId: string) => {
    const agent = await context.agentCore?.get(localProductId);
    const active = agent?.run && !["completed", "abandoned"].includes(agent.run.status);
    const local = active ? context.db.getProduct(localProductId) : undefined;
    const product = local ?? await context.remoteProducts.get(localProductId);
    return product.planning?.version === 2 ? toLegacyState(localProductId, product.planning) : undefined;
  });

  ipcMain.handle("planning:rerunMajorStage", (_event, localProductId: string, stage: PlanningMajorStage) => {
    if (!(["foundation", "itinerary", "completion"] as string[]).includes(stage)) {
      throw new Error("未知的规划阶段。");
    }
    const labels: Record<PlanningMajorStage, string> = {
      foundation: "产品基础",
      itinerary: "行程与资源",
      completion: "产品补全",
    };
    return sendPlanningIntent(localProductId,
      `请重新处理“${labels[stage]}”阶段。先读取当前产品，保留其它已验证内容，并说明本次会失效和重建的字段。`);
  });

  ipcMain.handle("planning:acceptItineraryAndRerunCompletion", (_event, localProductId: string) =>
    sendPlanningIntent(localProductId,
      "请采用当前每日行程作为后续工作的来源，核对所有景点 POI 后继续产品补全；缺失或歧义项先向我提问。"));
}

const NODE_TO_STAGE: Record<string, PlanningStage> = {
  skeleton: "skeleton",
  spotCandidates: "itinerary",
  poiResolution: "itinerary",
  itineraryDraft: "itinerary",
  hotelResolution: "itinerary",
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
