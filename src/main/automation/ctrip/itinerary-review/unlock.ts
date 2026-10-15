import {
  type ItineraryReviewMenu,
  type ItineraryReviewStepReceipt,
  type ItineraryReviewUnlockReceipt,
} from "../../../../shared/itinerary-review-unlock.js";
import {
  isItineraryReviewCompletedMenus,
  productMenuCore,
  readProductMenus,
  verifyProductDraftMenus,
} from "../product-menu-readback.js";
import { getVbkInitialState, postTrafficLineSoa, type TrafficLinePage } from "../traffic-line/client.js";
import { fetchTourDailyDetail, fetchTourInfoId } from "../itinerary-api/steps.js";
import { calculateTourScoreStep, checkTourDailyStep, saveTourDailyDetailStep } from "../itinerary-api/steps.js";
import { SAVE_TOUR_INFO_URL, SOHEAD, postSoa } from "../itinerary-api/transport.js";
import { getProductBaseInfoApi } from "../basic-info/read-base.js";
import { readTrafficLineChildren } from "../traffic-line/relationships.js";
import {
  ItineraryReviewDigestMismatchError,
  itineraryContentDifferencePaths,
  itineraryContentDigest,
  readItineraryReviewEvidence,
  reviewTourInfoId,
  verifyPlannedItinerary,
  type ItineraryReviewEvidence,
} from "./evidence.js";

export type { ItineraryReviewEvidence } from "./evidence.js";

function now(): string { return new Date().toISOString(); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function sameProduct(value: unknown, productId: string): boolean { return String(value ?? "") === String(Number(productId)); }

function receipt(step: string, endpoint: string, saveType?: number): ItineraryReviewStepReceipt {
  return { step, endpoint, ...(saveType === undefined ? {} : { saveType }), ack: "Success", at: now() };
}

function assertChecked(detail: Record<string, unknown>, before: ItineraryReviewEvidence, productId: string, step: string): void {
  const responseProductId = detail.productId;
  // The official check response sometimes returns 0 for this derived field.
  // Its productTourInfo relation remains the authoritative identity proof.
  if (responseProductId !== undefined && String(responseProductId) !== "0" && !sameProduct(responseProductId, productId)) {
    throw new Error(`${step}返回的产品身份不一致。`);
  }
  const afterDigest = itineraryContentDigest(detail);
  if (afterDigest !== before.contentDigest) {
    throw new ItineraryReviewDigestMismatchError({
      step,
      beforeDigest: before.contentDigest,
      afterDigest,
      paths: itineraryContentDifferencePaths(before.detail, detail),
    });
  }
}

function scored(detail: Record<string, unknown>, score: Awaited<ReturnType<typeof calculateTourScoreStep>>) {
  return {
    ...structuredClone(detail),
    ...(score.aggregateScore === undefined ? {} : { aggregateScore: score.aggregateScore }),
    ...(score.tourInfoScores === undefined ? {} : { tourInfoScores: score.tourInfoScores }),
  };
}

function assertVisaResponse(value: Record<string, unknown>): void {
  const nonempty = (item: unknown) => Array.isArray(item) ? item.length > 0
    : item && typeof item === "object" ? Object.keys(item).length > 0
    : typeof item === "string" ? Boolean(item.trim()) : item !== undefined && item !== null && item !== false && item !== 0;
  if (nonempty(value.addMessage) || nonempty(value.deleteMessage)) {
    throw new Error("签证适用范围发生变化，审核已停止，需取得新的明确确认。");
  }
}

function associationForSubmit(association: Record<string, unknown>, productId: string, tourInfoId: string): Record<string, unknown> {
  if (!sameProduct(association.productId, productId)) throw new Error("审核校验返回的行程关联产品身份不一致。");
  return { ...association, productId: Number(productId), tourInfoId };
}

function assertCheckedAssociation(association: Record<string, unknown> | undefined, productId: string): void {
  if (association && !sameProduct(association.productId, productId)) {
    throw new Error("审核校验返回的行程关联产品身份不一致。");
  }
}

/** Runs only the official itinerary-review protocol. It never publishes or creates children. */
export async function submitItineraryReviewUnlock(
  page: TrafficLinePage,
  before: ItineraryReviewEvidence,
  options: {
    assertCurrent?: () => void | Promise<void>;
    onStep?: (step: ItineraryReviewStepReceipt) => void;
    /** 第一次真正派发远端写入前调用：此前的失败都只发生只读校验阶段。 */
    onWrite?: () => void;
  } = {},
): Promise<void> {
  if (before.fullyUnlocked) return;
  const check = async () => { await options.assertCurrent?.(); };
  const productId = before.productId;
  const initialText = JSON.stringify({ ...before.detail, productId: Number(productId), tourInfoId: before.tourInfoId });
  let checkedAssociation: Record<string, unknown> | undefined;
  await check();
  const checked8 = await checkTourDailyStep(page, before.relation, initialText, 8, "行程审核校验", relation => { checkedAssociation = relation; });
  assertChecked(checked8, before, productId, "审核校验");
  assertCheckedAssociation(checkedAssociation, productId);
  options.onStep?.(receipt("check8", "15638/checkTourDaily", 8));

  await check();
  const score = await calculateTourScoreStep(page, checked8);
  if (!Number.isFinite(score.aggregateScore) || !Array.isArray(score.tourInfoScores)) {
    throw new Error("行程评分响应缺少有效 aggregateScore 或 tourInfoScores，已停止审核提交。");
  }
  const scoreApplied = scored(checked8, score);
  assertChecked(scoreApplied, before, productId, "行程评分");
  options.onStep?.(receipt("calculateScore", "20049/calculateTourInfoScore"));

  let submitAssociation: Record<string, unknown> | undefined;
  await check();
  const checked3 = await checkTourDailyStep(page, checkedAssociation ?? before.relation, JSON.stringify(scoreApplied), 3,
    "行程审核提交校验", relation => { submitAssociation = relation; });
  assertChecked(checked3, before, productId, "审核提交校验");
  assertCheckedAssociation(submitAssociation, productId);
  options.onStep?.(receipt("check3", "15638/checkTourDaily", 3));

  await check();
  options.onWrite?.();
  const saved = await saveTourDailyDetailStep(page, checked3);
  if (String(saved.tourInfoId ?? "") !== String(checked3.tourInfoId ?? "")) throw new Error("审核行程详情保存未返回当前行程 ID。");
  options.onStep?.(receipt("saveDaily", "20049/saveTourDailyDetail.json"));

  const sale = record(record(before.base).saleControlInfo);
  await check();
  const visa = await postTrafficLineSoa(page, "15638", "calculateNeedAppliedVisa", {
    productId: Number(productId), inputLocale: sale.inputLocale, saleMode: sale.saleMode,
    productPatternId: sale.productPatternID, productCategoryId: sale.productCategoryID,
    tourinfoId: saved.tourInfoId,
  }, "行程审核签证适用计算");
  assertVisaResponse(visa);
  options.onStep?.(receipt("calculateNeedAppliedVisa", "15638/calculateNeedAppliedVisa"));

  await check();
  options.onWrite?.();
  const association = associationForSubmit(submitAssociation ?? checkedAssociation ?? before.relation, productId, String(checked3.tourInfoId));
  await postSoa(page, SAVE_TOUR_INFO_URL, {
    contentType: "json", head: SOHEAD, saveType: 3, tourInfo: association, tourDaily: JSON.stringify(checked3),
  }, "提交行程审核", { referrer: `https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=${encodeURIComponent(productId)}&from=vbk` });
  options.onStep?.(receipt("saveProduct3", "15638/saveProductTourInfo", 3));
}

function pageProductId(state: Record<string, unknown>): string {
  const location = record(state.location);
  const query = record(location.query);
  const direct = query.productid ?? query.productId;
  if (direct !== undefined) return String(direct);
  const raw = typeof location.href === "string" ? location.href : typeof location.search === "string" ? `https://vbooking.ctrip.com/${location.search}` : "";
  try { return new URL(raw).searchParams.get("productid") ?? new URL(raw).searchParams.get("productId") ?? ""; } catch { return ""; }
}

async function verifyTabs(page: TrafficLinePage, productId: string, menus: ItineraryReviewMenu[]) {
  return Promise.all(menus.map(async (menu) => {
    const url = new URL(menu.url, "https://vbooking.ctrip.com").href;
    const state = await getVbkInitialState(page, url, `审核解锁页面回读：${menu.title || menu.key}`);
    if (state.action === "login" || String(record(state.location).pathname ?? "") === "/login") throw new Error(`审核解锁页面回读进入登录页：${menu.key}`);
    if (!sameProduct(pageProductId(state), productId)) throw new Error(`审核解锁页面产品身份不一致：${menu.key}`);
    return { key: menu.key, title: menu.title, url: menu.url, verified: true as const };
  }));
}

export async function verifyItineraryReviewUnlock(
  page: TrafficLinePage,
  productId: string,
  expectedDigest?: string,
  product?: unknown,
  options: { verifyPlan?: typeof verifyPlannedItinerary } = {},
): Promise<ItineraryReviewUnlockReceipt> {
  const [base, relation] = await Promise.all([getProductBaseInfoApi(page, productId), fetchTourInfoId(page, productId)]);
  if (!sameProduct(relation.tourInfo.productId, productId)) throw new Error("审核后行程关联产品身份不一致。");
  const tourInfoId = reviewTourInfoId(relation.tourInfo);
  const detail = (await fetchTourDailyDetail(page, tourInfoId)).tourInfo;
  if (!detail) throw new Error("审核后未读取到行程详情。");
  if (String(detail.tourInfoId ?? "") !== tourInfoId) throw new Error("审核后行程详情版本不一致。");
  if (detail.productId !== undefined && !sameProduct(detail.productId, productId)) throw new Error("审核后行程详情产品身份不一致。");
  const afterDigest = itineraryContentDigest(detail);
  const digestChanged = Boolean(expectedDigest && afterDigest !== expectedDigest);
  const menus = await readProductMenus(page, productId);
  if (!isItineraryReviewCompletedMenus(menus)) {
    throw new Error("审核后未形成连续的套餐管理解锁边界。");
  }
  const info = record(base.baseInfo); const meta = record(base.meta);
  const routeId = Number(info.routeId) || 0;
  const auditKey = String(record(relation.tourInfo).auditStatus?.key ?? "");
  if (routeId <= 0 || !["A", "N"].includes(auditKey)) throw new Error("行程审核尚未通过远端回读。");
  const publication = { active: String(info.active ?? base.active ?? ""), isonline: String(meta.isonline ?? info.isonline ?? base.isonline ?? ""), releaseActive: String(meta.releaseActive ?? base.releaseActive ?? "") };
  if (publication.active !== "F" || publication.isonline !== "F" || publication.releaseActive !== "F") throw new Error("审核解锁不得改变产品发布状态。");
  const children = await readTrafficLineChildren(page, productId);
  if (children.length) throw new Error("审核解锁不得创建交通子产品。");
  const tabs = await verifyTabs(page, productId,
    productMenuCore(menus.menus).filter(menu => menu.enabled === "T"));
  if (product) {
    const planned = await (options.verifyPlan ?? verifyPlannedItinerary)(page, product, productId, tourInfoId);
    if (planned.contentDigest !== afterDigest) throw new Error("完整行程方案回读与审核详情摘要不一致。");
  }
  if (digestChanged && !product) throw new Error("审核后行程内容与提交前不一致。");
  return { verified: true, productId, tourInfoId, contentDigest: afterDigest,
    beforeDigest: expectedDigest ?? afterDigest, afterDigest, routeId,
    maxStep: menus.maxStep, menus: menus.menus, publication: publication as ItineraryReviewUnlockReceipt["publication"], trafficChildren: 0,
    checkedAt: now(), tabs, requestSteps: [] };
}

/** Guards a stale caller from submitting the wrong menu state before any write. */
export async function assertItineraryReviewBoundary(page: TrafficLinePage, before: ItineraryReviewEvidence): Promise<void> {
  if (before.fullyUnlocked) return;
  const fresh = await readItineraryReviewEvidence(page, before.productId);
  if (fresh.fullyUnlocked || fresh.contentDigest !== before.contentDigest || fresh.tourInfoId !== before.tourInfoId) throw new Error("行程审核前远端状态已变化，请重新确认。");
  await verifyProductDraftMenus(page, before.productId, { base: fresh.base, tourInfo: fresh.relation, verifiedTourInfoId: fresh.tourInfoId });
}
