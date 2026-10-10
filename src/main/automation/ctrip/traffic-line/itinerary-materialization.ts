import { orderItineraryMeals } from "../itinerary-api/meal-order.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { calculateTourScoreStep, checkTourDailyStep, fetchTourDailyDetail, fetchTourInfoId, saveProductTourInfoStep, saveTourDailyDetailStep } from "../itinerary-api/steps.js";
import { list, text, type JsonRecord, type TrafficLinePage } from "./client.js";
import { applyRequiredPoiRiskPlans, mergeTrafficNodes, verifyTrafficNodes, currentTrafficLineTourInfoId, readTrafficNodesFromPage } from "./itinerary.js";

export class TrafficLineItineraryReadbackError extends Error {
  constructor(readonly expectedTourInfoId: string, message: string) { super(message); }
}
export async function ensureTrafficLineItinerary(page: TrafficLinePage, productId: string, variant: TrafficLineVariant, endpoints?: TrafficLineEndpointPlan): Promise<{ days: number; transportNodes: number }> {
  try { return await saveTrafficLineItineraryOnce(page, productId, variant, endpoints); }
  catch (error) {
    return recoverMissingTrafficItinerary(error,
      async () => currentTrafficLineTourInfoId(await fetchTourInfoId(page, productId)),
      () => saveTrafficLineItineraryOnce(page, productId, variant, endpoints));
  }
}

/** Only repair missing edges once, on the same authoritative linked version. */
export async function recoverMissingTrafficItinerary<T>(error: unknown, readCurrentId: () => Promise<string>, repair: () => Promise<T>): Promise<T> {
  if (!(error instanceof TrafficLineItineraryReadbackError) || !/缺少首日或末日目标交通节点/.test(error.message)) throw error;
  if (await readCurrentId() !== error.expectedTourInfoId) throw error;
  return repair();
}

async function saveTrafficLineItineraryOnce(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints?: TrafficLineEndpointPlan,
): Promise<{ days: number; transportNodes: number }> {
  const source = await readTrafficNodesFromPage(page, productId, variant);
  const linked = await fetchTourInfoId(page, productId);
  const productTourInfo = linked.tourInfo;
  const tourInfoId = currentTrafficLineTourInfoId(linked);
  if (!tourInfoId) throw new Error("子产品缺少已关联行程，无法安全合并交通节点。");
  const detail = await fetchTourDailyDetail(page, tourInfoId);
  if (!detail.tourInfo) throw new Error("子产品行程详情回读为空，无法安全合并交通节点。");

  const merged = applyRequiredPoiRiskPlans(mergeTrafficNodes(detail.tourInfo, source.first, source.last, variant, endpoints));
  const descriptions = list(merged.tourDailyDescriptions);
  for (const day of descriptions) day.tourDailyInfos = orderItineraryMeals(list(day.tourDailyInfos));
  const base = { ...productTourInfo, productId, tourInfoId, days: descriptions.length };
  const checked8 = await checkTourDailyStep(page, base, JSON.stringify(merged), 8, "校验子产品行程交通");
  const score = await calculateTourScoreStep(page, { ...base, aggregateScore: checked8.aggregateScore });
  const checked3 = await checkTourDailyStep(page, base, JSON.stringify({
    ...checked8,
    aggregateScore: score.aggregateScore ?? checked8.aggregateScore,
    tourInfoScores: score.tourInfoScores,
  }), 3, "保存子产品行程交通");
  verifyTrafficNodes(checked3, variant);
  await saveTourDailyDetailStep(page, checked3);
  const savedId = text(checked3.tourInfoId);
  if (!savedId) throw new Error("子产品行程交通保存后未生成 tourInfoId。");
  const final = {
    ...checked3,
    productId,
    tourInfoId: savedId,
    auditTourInfoId: savedId,
    main: productTourInfo.main ?? true,
    sort: productTourInfo.sort ?? 0,
  };
  await saveProductTourInfoStep(page, final, JSON.stringify(final));
  return waitForTrafficLineItineraryReadback(async () => {
    const linked = await fetchTourInfoId(page, productId);
    const linkedId = currentTrafficLineTourInfoId(linked);
    if (linkedId !== savedId) return { tourInfoId: linkedId, tourInfo: null };
    const readback = await fetchTourDailyDetail(page, linkedId);
    return { tourInfoId: linkedId, tourInfo: readback.tourInfo ?? null };
  }, savedId, variant);
}

export async function waitForTrafficLineItineraryReadback(
  read: () => Promise<{ tourInfoId: string | number; tourInfo: JsonRecord | null }>,
  expectedTourInfoId: string,
  variant: TrafficLineVariant,
  options: {
    maxPolls?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<{ days: number; transportNodes: number }> {
  const maxPolls = options.maxPolls ?? 40;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    try {
      const readback = await read();
      const actualId = text(readback.tourInfoId);
      if (actualId !== expectedTourInfoId) {
        throw new Error(`当前绑定行程 ID=${actualId || "空"}，期望=${expectedTourInfoId}`);
      }
      if (!readback.tourInfo) throw new Error("当前绑定行程详情为空");
      const transportNodes = verifyTrafficNodes(readback.tourInfo, variant);
      return { days: list(readback.tourInfo.tourDailyDescriptions).length, transportNodes };
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxPolls) await sleep(Math.min(1_500, attempt * 500));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "未知错误");
  throw new TrafficLineItineraryReadbackError(expectedTourInfoId, `子产品行程交通保存后在 ${maxPolls} 次只读回读中未收敛：${detail}`);
}
