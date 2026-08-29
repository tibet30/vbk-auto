/**
 * itinerary 阶段「全量接口保存」主入口：fillItineraryDraftApi。
 *
 * 设计目标：彻底替换原 fillItineraryDraft 的 DOM 写入路径，
 *   - 第一步：调 ensureItineraryApi 走 soa2 全量接口（getTourInfo →
 *     getTourDailyDetail → suggestAirport / suggestTrainStation →
 *     transformItinerary → checkTourDaily(saveType=8) →
 *     calculateTourInfoScore → checkTourDaily(saveType=3) →
 *     saveTourDailyDetail → saveProductTourInfo → getTourDailyDetail
 *     回读校验）。任何一步 Ack=Failure / 字段缺失 / 回读不一致都会抛错；
 *   - 第二步：回读成功后直接返回结构化结果供 audit / 落库 / 下游 phase 接力；
 *     不导航、不水合 DOM，也不点击「提交审核并下一步」。
 *
 * 与 fillItineraryDraft（DOM 版）的差异：
 *   - 不再按 day 填 title textarea / 包车 / 接送站 / 餐食 / 酒店卡片；
 *   - 不再调 stations DOM helper（fillPickupAndDropoff / handleAirportTrainModal）；
 *   - 不再用 cards DOM helper（fillHotelCard / fillMealCards）；
 *   - 行程数据完全由 itinerary-transform.ts 生成 VBK 协议 payload 走接口写入。
 */

import type { Page } from "playwright";
import { ensureItineraryApi } from "../itinerary-api.js";
import type { ProductItineraryDay, ProductOperations } from "../itinerary-api/itinerary-transform.js";

export interface FillItineraryDraftApiOptions {
  disambiguator?: unknown;
  productId?: string | number;
}

export interface FillItineraryDraftApiResult {
  savedWith: string;
  days: number;
  apiResult: unknown;
}

export interface ItineraryDraftProduct {
  itinerary?: ProductItineraryDay[];
  operations?: ProductOperations;
  productId?: string | number;
}

/**
 * 行程阶段全量接口保存主入口。
 */
export async function fillItineraryDraftApi(
  page: Page,
  product: ItineraryDraftProduct,
  options: FillItineraryDraftApiOptions = {},
): Promise<FillItineraryDraftApiResult> {
  const productId = String(options?.productId || product?.productId || "");
  if (!productId) {
    throw new Error("行程阶段全量接口保存：产品 ID 缺失，无法继续。");
  }
  if (!Array.isArray(product?.itinerary) || product.itinerary.length === 0) {
    throw new Error("行程阶段全量接口保存：行程数组为空，无法继续。");
  }

  // 1) 全量接口保存 + 回读校验（任何字段缺失或 Ack=Failure 都会抛错）。
  //    这里不做 DOM 导航；会话请求直接在已登录页面上下文执行。
  const apiResult = await ensureItineraryApi(page, {
    itinerary: product.itinerary,
    operations: product.operations,
    productId: product.productId,
  }, productId);
  if (!apiResult?.tourInfoId) {
    throw new Error("行程阶段全量接口保存：ensureItineraryApi 未返回合法 tourInfoId。");
  }

  return {
    savedWith: "itinerary-api",
    days: product.itinerary.length,
    apiResult,
  };
}
