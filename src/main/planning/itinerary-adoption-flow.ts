import type { PlanningPlanV2, PlanningRunResult } from "../../shared/contracts.js";
import type { MainIpcContext } from "../ipc/context.js";
import { suggestPoiDetail } from "../infrastructure/poi-suggest.js";
import { resetProductForPlanningStage } from "./planning-v2-reset.js";
import {
  applyUnmatchedPoiSourcePolicy,
  collectRequiredItinerarySpots,
  guardLatestItineraryAdoption,
  isTravelNodeName,
  markItineraryAccepted,
  markItineraryPendingAdoption,
  markItineraryVerifying,
} from "./itinerary-adoption.js";

type ItineraryPoiLookup = (
  name: string,
  context: { destinationCity: string; province: string },
) => Promise<{ poiName: string; poiId: number } | null>;

export async function acceptItineraryAndRerunCompletion(args: {
  context: MainIpcContext;
  localProductId: string;
  accepting: Set<string>;
  run(localProductId: string, plan: PlanningPlanV2): Promise<PlanningRunResult>;
  /** 测试或调用方可注入；生产环境默认使用当前 VBK 页面查询。 */
  lookupPoi?: ItineraryPoiLookup;
}): Promise<PlanningRunResult> {
  const { context, localProductId, accepting, run } = args;
  if (accepting.has(localProductId)) throw new Error("当前行程正在采用，请勿重复点击。");
  accepting.add(localProductId);
  try {
    let remote = await context.remoteProducts.get(localProductId);
    if (!remote.revision) throw new Error("Tibet 产品缺少 revision，无法安全采用行程。");
    const existingPlan = remote.planning;
    if (!existingPlan || existingPlan.version !== 2) {
      throw new Error("当前产品没有可采用的三阶段规划状态，请先按新流程规划。");
    }
    if (existingPlan.status === "running") throw new Error("方案正在生成中，请稍候再采用行程。");
    if (existingPlan.itineraryAdoption?.status === "verifying") throw new Error("行程正在核验真实 POI，请稍候。");
    if (existingPlan.itineraryAdoption?.status === "accepted") throw new Error("当前行程已经采用，产品补全正在重做或已完成。");
    if (existingPlan.itineraryAdoption?.status !== "pending" && existingPlan.itineraryAdoption?.status !== "blocked") {
      throw new Error("当前没有待采用的对话行程，请先在对话中调整行程。");
    }
    const itinerary = remote.product.itinerary;
    const malformedDay = (Array.isArray(itinerary) ? itinerary : []).findIndex((day) => {
      const spots = asRecord(day)?.spots;
      return !Array.isArray(spots) || spots.length === 0 || spots.some((spot) => {
        const record = asRecord(spot);
        return typeof spot === "string" ? !spot.trim() : !text(record?.name) && !text(record?.poiName);
      });
    });
    if (malformedDay >= 0) throw new Error(`第${malformedDay + 1}天缺少可核验的景点名称，请继续调整行程。`);
    const required = collectRequiredItinerarySpots(itinerary).filter((spot) => !isTravelNodeName(spot.name));
    if (required.length === 0) throw new Error("当前行程没有可核验的游览景点，请先继续调整行程。");

    const verifying = markItineraryVerifying(existingPlan, itinerary);
    remote = await context.remoteProducts.update({ ...remote, status: "planning", planning: verifying, updatedAt: new Date().toISOString() }, remote.revision);
    context.db.importProductSnapshot(remote);
    context.broadcastProduct(remote);

    const basic = asRecord(remote.product.basicInfo) ?? {};
    const destinationCity = text(basic.destinationCity) || text(basic.meetingCity);
    const province = text(basic.province);
    let lookupPoi = args.lookupPoi;
    if (!lookupPoi) {
      try {
        await context.productWorkflows.runVbkPageExclusive(() => context.browser.status());
        lookupPoi = async (name, poiContext) => context.productWorkflows.runVbkPageExclusive(async () => {
          const page = await context.browser.page();
          const best = (await suggestPoiDetail(page, name, poiContext)).best;
          return best && Number.isInteger(best.poiId) && best.poiId > 0 && best.poiName.trim() && !isTravelNodeName(best.poiName)
            ? { poiName: best.poiName.trim(), poiId: best.poiId }
            : null;
        });
      } catch {
        // POI 是尽力匹配项。页面暂不可用时保留用户景点名，交给运营稍后手动配置。
      }
    }
    const matches = await resolveBestEffortPoiMatches(required, { destinationCity, province }, lookupPoi);
    const hydrated = applyUnmatchedPoiSourcePolicy(
      itinerary,
      matches,
      new Set(verifying.itineraryAdoption?.userRecommendedSpotNames ?? []),
    );

    const latest = await context.remoteProducts.get(localProductId);
    const guard = guardLatestItineraryAdoption(itinerary, latest.planning, latest.product.itinerary);
    if (!guard.ok) return await persistLatestPending(context, latest);
    const accepted = markItineraryAccepted(latest.planning!, hydrated.itinerary);
    const resetProduct = resetProductForPlanningStage({ ...latest.product, itinerary: hydrated.itinerary }, "completion");
    const prepared = await context.remoteProducts.update({
      ...latest,
      product: resetProduct,
      researchTasks: [],
      status: "planning",
      planning: accepted,
      updatedAt: new Date().toISOString(),
    }, latest.revision!);
    context.db.importProductSnapshot(prepared);
    context.broadcastProduct(prepared);
    return await run(localProductId, accepted);
  } finally {
    accepting.delete(localProductId);
  }
}

/** 查询是尽力而为：单点异常或整体不可用都只留下未绑定项，不阻断行程采用。 */
export async function resolveBestEffortPoiMatches(
  spots: ReturnType<typeof collectRequiredItinerarySpots>,
  poiContext: { destinationCity: string; province: string },
  lookupPoi?: ItineraryPoiLookup,
): Promise<Map<string, { poiName: string; poiId: number }>> {
  const matches = new Map<string, { poiName: string; poiId: number }>();
  for (const spot of lookupPoi ? spots : []) {
    try {
      const match = await lookupPoi!(spot.name, poiContext);
      if (match && Number.isInteger(match.poiId) && match.poiId > 0 && match.poiName.trim() && !isTravelNodeName(match.poiName)) {
        matches.set(spot.name, { poiName: match.poiName.trim(), poiId: match.poiId });
      }
    } catch {
      // 单个查询失败不再阻断采用；applyPoiMatches 会保留原名称和空 POI。
    }
  }
  return matches;
}

async function persistLatestPending(
  context: MainIpcContext,
  latest: Awaited<ReturnType<MainIpcContext["remoteProducts"]["get"]>>,
): Promise<never> {
  const plan = latest.planning;
  if (!plan || plan.version !== 2) throw new Error("行程已更新，请按最新版重新采用。");
  const pending = markItineraryPendingAdoption(plan, latest.product.itinerary);
  const saved = await context.remoteProducts.update({
    ...latest,
    status: "planning",
    planning: pending,
    updatedAt: new Date().toISOString(),
  }, latest.revision!);
  context.db.importProductSnapshot(saved);
  context.broadcastProduct(saved);
  throw new Error("行程已更新，请按最新版重新采用。");
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
