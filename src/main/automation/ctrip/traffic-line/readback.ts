import type { TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import type { TrafficLineEndpointPlan } from "../../../../shared/contracts-traffic-line.js";
import { fetchTourDailyDetail, fetchTourInfoId } from "../itinerary-api/steps.js";
import { ensureTrafficLinePackageActive } from "./activation.js";
import { ensureTrafficLineClauses } from "./clauses.js";
import { TrafficLineClauseReadbackError, verifyTrafficLineClauses } from "./clause-readback.js";
import { readTrafficLinePresentation, samePresentation } from "./presentation.js";
import { readTrafficLineChildren } from "./relationships.js";
import { readTrafficLineSegmentReadback } from "./segments.js";
import {
  currentTrafficLineTourInfoId,
  ensureTrafficLineItinerary,
  verifyTrafficNodes,
} from "./itinerary.js";
import { waitForStableReadbackGroup, type StableReadbackOptions } from "./stability.js";
import type { TrafficLineExistingChild } from "./types.js";
import type { TrafficLinePage } from "./client.js";

export interface TrafficLineChildReadback {
  child: TrafficLineExistingChild;
  tourInfoId: string;
  segmentCount: number;
  departureCityCount: number;
  transportNodes: number;
  clauseCount: number;
  presentationVerified: boolean;
}

export class TrafficLineItineraryReadbackError extends Error {
  readonly repairable: boolean;

  constructor(message: string, repairable = false) {
    super(message);
    this.name = "TrafficLineItineraryReadbackError";
    this.repairable = repairable;
  }
}

/** 最终聚合门保持纯读；任何定向修复只由外层稳定门在明确业务缺失后触发。 */
export async function verifyTrafficLineChild(
  page: TrafficLinePage,
  parentProductId: string,
  childProductId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
): Promise<TrafficLineChildReadback> {
  const children = await readTrafficLineChildren(page, parentProductId);
  const child = children.filter((candidate) => candidate.productId === childProductId);
  if (child.length !== 1) throw new Error("子产品最终回读无法唯一确认母子关系。");
  if (child[0]?.active !== true) throw new Error("子产品最终回读未确认套餐有效状态。");
  const [source, copied, segments, itinerary] = await Promise.all([
    readTrafficLinePresentation(page, parentProductId),
    readTrafficLinePresentation(page, childProductId),
    readTrafficLineSegmentReadback(page, childProductId, variant, endpoints),
    readTrafficLineItineraryReadback(page, childProductId, variant),
  ]);
  if (!samePresentation(source, copied)) throw new Error("子产品最终图文回读与母产品不一致。");
  const clauses = await verifyTrafficLineClauses(page, childProductId, variant, { syncRequired: false });
  return {
    child: child[0]!,
    tourInfoId: itinerary.tourInfoId,
    segmentCount: segments.segmentCount,
    departureCityCount: segments.departureCityCount,
    transportNodes: itinerary.transportNodes,
    clauseCount: clauses.formalClauseCount,
    presentationVerified: true,
  };
}

/** 已有效子产品只允许在可识别的行程/条款业务回读不完整时各定向修复一次。 */
export async function verifyTrafficLineChildWithRepair(
  page: TrafficLinePage,
  parentProductId: string,
  childProductId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
): Promise<TrafficLineChildReadback> {
  let itineraryRepaired = false;
  let clausesRepaired = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await verifyTrafficLineChild(page, parentProductId, childProductId, variant, endpoints);
    } catch (error) {
      if (error instanceof TrafficLineItineraryReadbackError && error.repairable && !itineraryRepaired) {
        itineraryRepaired = true;
        await ensureTrafficLineItinerary(page, childProductId, variant);
        continue;
      }
      if (error instanceof TrafficLineClauseReadbackError && !clausesRepaired) {
        clausesRepaired = true;
        await ensureTrafficLineClauses(page, childProductId, variant);
        continue;
      }
      throw error;
    }
  }
  throw new Error("子产品定向修复后最终回读仍未收敛。");
}

interface TrafficLineStableChild {
  variant: TrafficLineVariant;
  childProductId: string;
}

/** 所有兄弟子产品激活后按整组稳定；任一后续回绑都会重置完成门。 */
export async function verifyStableTrafficLineChildren(
  page: TrafficLinePage,
  parentProductId: string,
  children: readonly TrafficLineStableChild[],
  endpoints: TrafficLineEndpointPlan,
  options: StableReadbackOptions = {},
): Promise<TrafficLineChildReadback[]> {
  return waitForStableReadbackGroup(children, {
    key: (child) => child.childProductId,
    verify: (child) => verifyTrafficLineChild(
      page, parentProductId, child.childProductId, child.variant, endpoints,
    ),
    signature: (child, readback) => JSON.stringify({
      variant: child.variant,
      productId: child.childProductId,
      packageId: readback.child.packageId,
      active: readback.child.active,
      tourInfoId: readback.tourInfoId,
      segments: readback.segmentCount,
      departureCities: readback.departureCityCount,
      transportNodes: readback.transportNodes,
      clauses: readback.clauseCount,
      presentation: readback.presentationVerified,
    }),
    canRepair: (error) => error instanceof TrafficLineClauseReadbackError
      || (error instanceof TrafficLineItineraryReadbackError && error.repairable),
    repair: async (child, error) => {
      if (error instanceof TrafficLineItineraryReadbackError) {
        await ensureTrafficLineItinerary(page, child.childProductId, child.variant);
        return;
      }
      await ensureTrafficLineClauses(page, child.childProductId, child.variant);
    },
  }, options);
}

export async function activateAndVerifyTrafficLineChild(
  page: TrafficLinePage,
  parentProductId: string,
  child: TrafficLineExistingChild,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
): Promise<TrafficLineChildReadback> {
  const active = await activateTrafficLineChild(page, parentProductId, child, variant);
  return verifyTrafficLineChildWithRepair(page, parentProductId, active.productId, variant, endpoints);
}

export async function activateTrafficLineChild(
  page: TrafficLinePage,
  parentProductId: string,
  child: TrafficLineExistingChild,
  variant: TrafficLineVariant,
): Promise<TrafficLineExistingChild> {
  await verifyOrRepairTrafficLineClauses(page, child.productId, variant);
  let active: TrafficLineExistingChild;
  try {
    active = await ensureTrafficLinePackageActive(page, parentProductId, child);
  } catch (error) {
    // 只有服务端明确拒绝且指出条款未收敛时，写入没有被接受，允许
    // 再收敛一次条款后重试一次激活；超时/网络/其它业务错误不重提。
    if (!isTrafficLineClauseActivationError(error)) throw error;
    await ensureTrafficLineClauses(page, child.productId, variant);
    await verifyTrafficLineClauses(page, child.productId, variant);
    active = await ensureTrafficLinePackageActive(page, parentProductId, child);
  }
  return active;
}

export function isTrafficLineClauseActivationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:^|\D)20019014(?:\D|$)|必选条款.*(?:更新|保存)|条款.*(?:未保存|待保存)/u.test(message);
}

async function verifyOrRepairTrafficLineClauses(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
): Promise<void> {
  try {
    await verifyTrafficLineClauses(page, productId, variant);
  } catch (error) {
    if (!(error instanceof TrafficLineClauseReadbackError)) throw error;
    await ensureTrafficLineClauses(page, productId, variant);
    await verifyTrafficLineClauses(page, productId, variant);
  }
}

async function readTrafficLineItineraryReadback(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
): Promise<{ tourInfoId: string; transportNodes: number }> {
  const linked = await fetchTourInfoId(page, productId);
  const tourInfoId = currentTrafficLineTourInfoId(linked);
  if (!tourInfoId) throw new TrafficLineItineraryReadbackError("子产品最终行程回读缺少 tourInfoId。");
  const detail = await fetchTourDailyDetail(page, tourInfoId);
  if (!detail.tourInfo) throw new TrafficLineItineraryReadbackError("子产品最终行程回读为空。");
  const detailId = String(detail.tourInfo.tourInfoId ?? "");
  if (detailId && detailId !== tourInfoId) {
    throw new TrafficLineItineraryReadbackError(`子产品当前绑定行程 ID=${tourInfoId}，详情却返回 ID=${detailId}。`);
  }
  try {
    return { tourInfoId, transportNodes: verifyTrafficNodes(detail.tourInfo, variant) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TrafficLineItineraryReadbackError(message, true);
  }
}
