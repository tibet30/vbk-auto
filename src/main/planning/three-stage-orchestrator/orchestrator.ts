/**
 * three-stage-orchestrator/orchestrator：runThreeStagePlan 主流程。
 *
 *   1) 拉当前产品 → 抽取 userIdea → 标准化 skeleton.city → 跑 foundation；
 *   2) 解析 userIntent（userIdea 非空时）→ 验证 days → 写入 plan；
 *   3) 跑 itinerary：buildVerifiedPool → composeItinerary；
 *   4) 跑 hotelResolution：按是否有过夜日期决定 skipped / resolveHotels + 写 itinerary / 写酒店资源；
 *   5) 跑 completion：copy → presentation → commercial（必须先 presentation 写完再刷新 plan，
 *      避免旧 snapshot 覆盖新字段）；
 *   6) 串行跑 cover / vehicleResource（共享 VBK BrowserView，不能并行）；
 *   7) 收尾：扫完成性、finalValidation → plan.status = "completed"。
 */

import type { PlanningNodeId, PlanningNodeState, PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import { emptyPlanningUserIntent } from "../../../shared/contracts-planning-intent.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { AI_WRITABLE_PATHS } from "../schemas.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, ITINERARY_HOTEL_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { resolveItineraryHotelCandidates, shouldResolveItineraryHotelForDay } from "../../infrastructure/ctrip-hotel-search.js";
import { validateUserIntentDays } from "../user-intent.js";
import { buildVerifiedPool, composeItinerary, runFoundationLocation } from "../three-stage-itinerary-flow.js";
import { asRecord, errorMessage, failPlan, hasStandardLocation, isCompleted, node, text } from "./helpers.js";
import { normalisePlan } from "./plan-factory.js";
import { runCompletionAiNode, runResourceNode, runLegacyStage } from "./nodes.js";
import type { ThreeStageOrchestratorDependencies } from "./types.js";

export async function runThreeStagePlan(deps: ThreeStageOrchestratorDependencies): Promise<PlanningPlanV2> {
  let plan = normalisePlan(deps.initialPlan);
  let persistQueue = Promise.resolve();
  const commit = async () => {
    plan = { ...plan, updatedAt: new Date().toISOString(), nodes: [...plan.nodes], poiCandidates: [...plan.poiCandidates] };
    persistQueue = persistQueue.then(() => deps.persist(plan));
    await persistQueue;
  };
  const patchNode = async (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => {
    plan = {
      ...plan,
      currentNode: id,
      status: patch.status === "blocked" || patch.status === "failed" ? "needs_user" : "running",
      nodes: plan.nodes.map((node) => node.id === id ? { ...node, ...patch } : node),
    };
    await commit();
  };
  plan = { ...plan, status: "running" };
  await commit();
  const currentProduct = await deps.runtime.loadCurrentProduct(deps.localProductId);
  const currentBasic = asRecord(currentProduct.basicInfo);
  const userIdea = text(currentBasic.userIdea);
  deps.skeleton.city = toPlatformShortLocationName(
    text(currentBasic.meetingCity) || text(currentBasic.destinationCity) || deps.skeleton.city,
  );
  if (!isCompleted(plan, "skeleton") || !hasStandardLocation(deps.skeleton.province, deps.skeleton.city)) {
    const result = await runLegacyStage(deps, "skeleton", node(plan, "skeleton").attempts);
    if (result.status !== "completed") return failPlan(plan, patchNode, "skeleton", result.error);
    const location = await runFoundationLocation(deps, plan, patchNode, () => plan);
    if (!location.ok) return location.plan;
    plan = location.plan;
  }
  if (!plan.userIntent || plan.userIntent.rawIdea !== userIdea) {
    try {
      const userIntent = userIdea
        ? await deps.ai.structureUserIntent({ userIdea, destination: deps.skeleton.destination, days: deps.skeleton.days })
        : emptyPlanningUserIntent();
      const dayError = validateUserIntentDays(userIntent, deps.skeleton.days);
      if (dayError) return failPlan(plan, patchNode, "spotCandidates", dayError);
      plan = { ...plan, userIntent };
      await commit();
    } catch (error) {
      return failPlan(plan, patchNode, "spotCandidates", `用户想法解析失败：${errorMessage(error)}`);
    }
  }
  const itineraryReady = isCompleted(plan, "itineraryDraft");
  if (!itineraryReady) {
    const poolResult = await buildVerifiedPool(deps, plan, patchNode, () => plan, (next: PlanningPlanV2) => { plan = next; });
    if (!poolResult.ok) return poolResult.plan;
    plan = poolResult.plan;
    const itineraryResult = await composeItinerary(deps, plan, patchNode, () => plan, (next: PlanningPlanV2) => { plan = next; });
    if (!itineraryResult.ok) return itineraryResult.plan;
    plan = itineraryResult.plan;
  }
  if (!isCompleted(plan, "hotelResolution")) {
    const current = await deps.runtime.loadCurrentProduct(deps.localProductId);
    const itinerary = Array.isArray(current.itinerary) ? current.itinerary as Array<Record<string, unknown>> : [];
    if (!itinerary.some((day, index) => shouldResolveItineraryHotelForDay(day, index, deps.skeleton.nights))) {
      await patchNode("hotelResolution", {
        status: "skipped",
        summary: "行程无过夜日期，无需匹配酒店资源",
        completedAt: new Date().toISOString(),
      });
    } else {
      const attempt = node(plan, "hotelResolution").attempts + 1;
      await patchNode("hotelResolution", { status: "running", attempts: attempt, startedAt: new Date().toISOString(), error: undefined });
      try {
        const resolved = await deps.resolveHotels(itinerary, deps.skeleton.nights);
        const first = resolved.dailyCandidates[0]?.candidates[0];
        if (!first) throw new Error("酒店候选为空");
        const itineraryWrite = await deps.runtime.writeModule(deps.localProductId, "itinerary", AI_WRITABLE_PATHS.itinerary, resolved.itinerary);
        if (!itineraryWrite.ok) throw new Error(itineraryWrite.reason || "酒店候选行程写入失败");
        const operations = asRecord(current.operations) ?? {};
        if (!deps.runtime.writeResolvedHotelResources) throw new Error("酒店资源受控写入口不可用");
        const resourceWrite = await deps.runtime.writeResolvedHotelResources(deps.localProductId, {
          ...operations,
          hotelResource: {
            source: "ctrip", resourceId: first.hotelId, resourceName: first.hotelName, diamond: first.diamond,
            candidates: resolved.dailyCandidates[0]!.candidates, dailyCandidates: resolved.dailyCandidates,
          },
        });
        if (!resourceWrite.ok) throw new Error(resourceWrite.reason || "酒店资源配置写入失败");
        await patchNode("hotelResolution", { status: "completed", attempts: attempt,
          summary: `${resolved.dailyCandidates.length} 晚住宿，每晚按钻级和距离选取最多 ${HOTEL_RESOURCE_CANDIDATE_COUNT} 个携程酒店（至少 1 个即可继续）；行程录入前 ${ITINERARY_HOTEL_CANDIDATE_COUNT} 个，资源配置录入全部候选`, completedAt: new Date().toISOString() });
      } catch (error) {
        const message = errorMessage(error);
        await patchNode("hotelResolution", { status: "failed", attempts: attempt, error: message });
        return failPlan(plan, patchNode, "hotelResolution", message);
      }
    }
  }
  // 基础文案同时提供目的地上下文和后续提示词所需的摘要。展示与商业节点
  // 都会写产品字段并触发远端整包持久化；必须先完成 presentation 的写入与
  // 持久化，再刷新 plan，最后启动 commercial，避免旧 presentation 快照在
  // commercial 的 packageName/pricing 等写回后覆盖新字段。
  if (!isCompleted(plan, "copy")) {
    const completed = await runCompletionAiNode(deps, plan, "copy", "basicInfo", patchNode);
    plan = { ...plan, nodes: [...plan.nodes] };
    if (!completed) return plan;
  }
  if (!isCompleted(plan, "presentation")) {
    const completed = await runCompletionAiNode(deps, plan, "presentation", "presentation", patchNode);
    plan = { ...plan, nodes: [...plan.nodes] };
    if (!completed) return plan;
  }
  if (!isCompleted(plan, "commercial")) {
    const completed = await runCompletionAiNode(deps, plan, "commercial", "commercial", patchNode);
    plan = { ...plan, nodes: [...plan.nodes] };
    if (!completed) return plan;
  }

  // 封面与用车查询都会驱动同一个 VBK BrowserView 导航，不能并行使用页面。
  // 两个节点仍各自保留 3 次重试，但资源查询本身必须串行，避免一个节点的
  // page.goto / page.evaluate 销毁另一个节点的执行上下文。
  plan = { ...plan, nodes: [...plan.nodes] };
  if (!isCompleted(plan, "cover")) {
    await runResourceNode(deps, plan, "cover", patchNode, deps.resolveCover);
    plan = { ...plan, nodes: [...plan.nodes] };
  }
  if (!isCompleted(plan, "vehicleResource") && node(plan, "vehicleResource").status !== "skipped") {
    if (deps.privateTour) {
      await runResourceNode(deps, plan, "vehicleResource", patchNode, deps.resolveVehicle);
    } else {
      await patchNode("vehicleResource", { status: "skipped", summary: "跟团游无需匹配私家团用车资源组", completedAt: new Date().toISOString() });
    }
  }
  const failed = plan.nodes.find((entry) => entry.majorStage === "completion" && (entry.status === "failed" || entry.status === "blocked"));
  if (failed) {
    plan = { ...plan, status: "needs_user", currentNode: failed.id };
    await commit();
    return plan;
  }
  const requiredComplete = ["copy", "presentation", "commercial", "cover"] as PlanningNodeId[];
  if (deps.privateTour) requiredComplete.push("vehicleResource");
  const missing = requiredComplete.filter((id) => !isCompleted(plan, id));
  if (missing.length > 0) return failPlan(plan, patchNode, "finalValidation", `产品补全节点未通过：${missing.join("、")}`);
  await patchNode("finalValidation", {
    status: "completed",
    attempts: node(plan, "finalValidation").attempts + 1,
    summary: "行程、封面和用车资源已完成规划检查；缺失 POI 需在自动录入前手动配置",
    error: undefined,
    completedAt: new Date().toISOString(),
  });
  plan = { ...plan, status: "completed", currentNode: "finalValidation" };
  await commit();
  return plan;
}