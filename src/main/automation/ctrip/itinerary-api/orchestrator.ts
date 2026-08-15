/**
 * itinerary-api/orchestrator.ts：
 *   - 行程阶段主入口 ensureItineraryApi / ensureItinerarySpotsApi / countItineraryApiSpots；
 *   - 串起 transport / steps / stations-resolver / readback 各模块；
 *   - 不做单接口包装（那是 steps.ts 的事）；不做字段级校验（那是 readback.ts
 *     的事）；只负责"按顺序把 step 接起来 + 拼装 tourInfo payload"。
 *
 * 调用顺序：
 *   1. 接送站解析（stations-resolver）
 *   2. 拉取当前 tourInfoId（steps.fetchTourInfoId）
 *   3. 拉取详情模板（steps.fetchTourDailyDetail）用于非破坏合并
 *   3a. 空产品补拉行程模板（steps.fetchDailyTemplateDetail）→ newTourInfo.template/templateId
 *   4. itinerary-transform 生成 tourDailyDescriptions
 *   5. 拼装 newTourInfo payload（含 template / templateId / days / tourDailyDescriptions）
 *   6. checkTourDaily(8) → calculateTourInfoScore → checkTourDaily(3)
 *      （关键修复：initialText / checked8Text 都用 JSON.stringify(newTourInfo)，
 *       保留 draftTourInfoId / template 等元数据，避免后端拒绝）
 *   7. saveTourDailyDetail（响应允许仅含顶层 tourInfoId）+ saveProductTourInfo
 *   8. 字段级回读校验（readback.verifyItineraryReadback）
 *   9. 返回 ItineraryApiResult
 */

import {
  buildReadbackExpectations,
  type ProductItineraryDay,
  type ProductOperations,
  transformItinerary,
} from "./itinerary-transform.js";
import { verifyItineraryReadback } from "./readback.js";
import { enrichItineraryPoiMetadata } from "./poi-metadata.js";
import { resolveStationsForCity } from "./stations-resolver.js";
import {
  DEFAULT_DAILY_TEMPLATE_ID,
  calculateTourScoreStep,
  checkTourDailyStep,
  fetchDailyTemplateDetail,
  fetchTourDailyDetail,
  fetchTourInfoId,
  saveProductTourInfoStep,
  saveTourDailyDetailStep,
} from "./steps.js";
import type { ApiPage, ItineraryApiResult } from "./transport.js";

export async function ensureItineraryApi(
  page: ApiPage,
  product: { itinerary: ProductItineraryDay[]; operations?: ProductOperations; productId?: string | number },
  productId: string,
): Promise<ItineraryApiResult> {
  if (!Array.isArray(product?.itinerary) || !product.itinerary.length) {
    throw new Error("行程数组为空，无法走接口保存。");
  }
  const operations: ProductOperations = product.operations ?? {};
  if (!operations.pickupCity) {
    throw new Error("operations.pickupCity 缺失，无法解析接送站。");
  }

  // 1) 接送站解析（真实接口）
  const stations = await resolveStationsForCity(page, operations.pickupCity);
  if (!stations.pickupAir && !stations.pickupTrain) {
    throw new Error(`接送站搜索：城市「${operations.pickupCity}」无任何可用机场/火车站候选。`);
  }

  // 2) 按 poiId 回查真实 suggestPoi 类型，避免免费景点因 ticketType 为空被拒。
  const enrichedItinerary = await enrichItineraryPoiMetadata(page, product.itinerary);

  // 3) 拉取当前 tourInfoId + 模板 ID（draftTourInfoId 优先级保留）
  const { tourInfo, tourInfoId: existingTourInfoId, templateId: fetchedTemplateId } =
    await fetchTourInfoId(page, productId);
  const templateId = fetchedTemplateId ?? DEFAULT_DAILY_TEMPLATE_ID;

  // 4) 拉取详情模板（用于非破坏合并；draftTourInfoId 场景也走这里）
  let detailTourInfo: Record<string, unknown> | null = null;
  if (existingTourInfoId) {
    const detail = await fetchTourDailyDetail(page, existingTourInfoId);
    detailTourInfo = detail.tourInfo;
  }

  // 4a) 空产品：拉行程模板（getDailyTemplateDetail）→ 写入 newTourInfo.template/templateId
  let template: Record<string, unknown> | null = null;
  if (!existingTourInfoId) {
    const templateResult = await fetchDailyTemplateDetail(page, templateId);
    template = templateResult.template;
  }
  const isPreviewDraft = Boolean(
    tourInfo.previewTourInfoId
    && (!tourInfo.tourInfoId || String(tourInfo.tourInfoId) === "0")
    && !tourInfo.auditTourInfoId,
  );

  // 5) 用 itinerary-transform 生成完整 tourDailyDescriptions
  const tourDailyDescriptions = transformItinerary({
    itinerary: enrichedItinerary,
    operations,
    stations,
  });

  // 5) 拼装完整 tourInfo payload（含 template / templateId / days / tourDailyDescriptions）
  const newTourInfo: Record<string, unknown> = {
    ...(detailTourInfo ?? {}),
    ...(template ? { template } : {}),
    templateId,
    ...(!isPreviewDraft ? { productId: Number(productId) || productId } : {}),
    tourInfoId: isPreviewDraft ? 0 : existingTourInfoId || 0,
    days: tourDailyDescriptions.length,
    tourDailyDescriptions,
    ...(isPreviewDraft ? { isModify: true } : {}),
  };

  // 6) checkTourDaily saveType=8 → calculateTourInfoScore → checkTourDaily saveType=3
  //    productTourInfo 同步写入 template / templateId / days，保证后端能识别。
  const productTourInfo: Record<string, unknown> = isPreviewDraft
    ? {
        ...tourInfo,
        productId: Number(productId) || productId,
        tourInfoId: 0,
      }
    : {
        ...tourInfo,
        ...(template ? { template } : {}),
        templateId,
        productId: Number(productId) || productId,
        tourInfoId: existingTourInfoId || 0,
        days: tourDailyDescriptions.length,
      };
  // 关键修复：用 JSON.stringify(newTourInfo) 替代 JSON.stringify({ tourDailyDescriptions })，
  // 保留 draftTourInfoId / template / templateId 等元数据，避免后端把请求当作"空对象"。
  const initialText = JSON.stringify(newTourInfo);
  const initialSaveType = isPreviewDraft ? 7 : 8;
  const checked8 = await checkTourDailyStep(
    page,
    productTourInfo,
    initialText,
    initialSaveType,
    `VBK 行程校验(saveType=${initialSaveType})`,
  );
  const scoreResult = await calculateTourScoreStep(page, {
    ...productTourInfo,
    aggregateScore: (checked8 as { aggregateScore?: number }).aggregateScore,
  });
  (checked8 as { aggregateScore?: number }).aggregateScore =
    scoreResult.aggregateScore ?? (checked8 as { aggregateScore?: number }).aggregateScore;
  (checked8 as { tourInfoScores?: unknown }).tourInfoScores = scoreResult.tourInfoScores;
  const checked8Text = typeof checked8 === "object" ? JSON.stringify(checked8) : String(checked8);
  const checked3 = await checkTourDailyStep(page, productTourInfo, checked8Text, 3, "VBK 行程校验(saveType=3)");

  // 7) 保存详情 + 保存关联
  //    saveTourDailyDetail 响应允许仅含顶层 tourInfoId；savedTourInfoId 一律以
  //    checkTourDaily(saveType=3) 响应的 tourInfoId 为准，保证后续回读 ID 一致。
  await saveTourDailyDetailStep(page, checked3);
  const savedTourInfoId = (checked3 as { tourInfoId?: string | number }).tourInfoId;
  if (!savedTourInfoId) {
    throw new Error("VBK 行程详情保存后未生成新 tourInfoId");
  }
  const finalTourInfo = {
    ...checked3,
    productId: Number(productId) || productId,
    main: productTourInfo.main ?? true,
    sort: productTourInfo.sort ?? 0,
    tourInfoId: savedTourInfoId,
    auditTourInfoId: savedTourInfoId,
    auditTourInfoStatus: 1,
    aggregateScore: checked3.aggregateScore ?? scoreResult.aggregateScore ?? 100,
  };
  await saveProductTourInfoStep(page, finalTourInfo, JSON.stringify(finalTourInfo));

  // 8) 完整回读校验（字段级逐天比对）
  const readbackExpectations = buildReadbackExpectations({
    itinerary: product.itinerary,
    operations,
    stations,
  });
  const verify = await verifyItineraryReadback(page, savedTourInfoId, readbackExpectations);

  // 9) 业务结果
  return {
    productId,
    tourInfoId: savedTourInfoId,
    auditTourInfoId: savedTourInfoId,
    days: verify.days,
    savedSpots: verify.spots,
    savedMeals: verify.meals,
    savedHotels: verify.hotels,
    pickupAirport: stations.pickupAir?.code ?? "",
    pickupTrain: stations.pickupTrain?.code ?? "",
    dropoffAirport: stations.dropoffAir?.code ?? "",
    dropoffTrain: stations.dropoffTrain?.code ?? "",
  };
}

/** 兼容旧入口：保留 spots-only API 入口供 itinerary/main.ts 接入。 */
export async function ensureItinerarySpotsApi(
  page: ApiPage,
  product: { itinerary?: ProductItineraryDay[]; operations?: ProductOperations; productId?: string | number },
  productId: string,
) {
  if (!product.itinerary) throw new Error("行程数组为空。");
  return ensureItineraryApi(page, product as { itinerary: ProductItineraryDay[]; operations?: ProductOperations; productId?: string | number }, productId);
}

/** 兼容旧单元测试：只统计景点 POI 数量。 */
export function countItineraryApiSpots(detail: {
  tourInfo?: {
    tourDailyDescriptions?: Array<{
      tourDailyInfos?: Array<{ activeType?: { key?: number; name?: string }; tourDailyPois?: unknown[] }>;
    }>;
  };
}): number {
  const days = detail?.tourInfo?.tourDailyDescriptions ?? [];
  return days.reduce(
    (total: number, day: { tourDailyInfos?: Array<{ activeType?: { key?: number; name?: string }; tourDailyPois?: unknown[] }> }) => {
      const infos = Array.isArray(day.tourDailyInfos) ? day.tourDailyInfos : [];
      return total + infos
        .filter((info) => info?.activeType?.key === 3 || info?.activeType?.name === "景点")
        .reduce(
          (dayTotal: number, info: { tourDailyPois?: unknown[] }) =>
            dayTotal + (Array.isArray(info.tourDailyPois) ? info.tourDailyPois.length : 0),
          0,
        );
    },
    0,
  );
}
