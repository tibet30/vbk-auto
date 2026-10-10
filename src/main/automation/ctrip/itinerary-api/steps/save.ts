/**
 * itinerary-api/steps/save.ts：写回 step（check / calculate / save）——
 *   - checkTourDailyStep：通用包装。响应 text 字段可能是字符串化的 JSON，
 *     需要解析；Ack=Success 但响应缺 tourDaily → 抛错；已验证的正常"存为草稿"
 *     流程只使用已采样的 saveType=2；响应中的详情 ID 由编排层结合关联版本处理；
 *   - calculateTourScoreStep：calculateTourInfoScore（旧行程工具的评分计算；
 *     当前母产品草稿保存不调用此接口，保留导出供独立协议调用方使用）；
 *   - saveTourDailyDetailStep：saveTourDailyDetail。Ack=Success 但响应缺
 *     tourInfo / result / tourInfoId → 视为结构空失败；
 *   - saveProductTourInfoStep：saveProductTourInfo。正常"存为草稿"会保留关联
 *     列表返回的 formal/draft/audit/preview ID 和状态；严禁改写 audit、formal
 *     或 preview 指针。
 */

import {
  ApiPage,
  CALC_TOUR_SCORE_URL,
  CHECK_TOUR_DAILY_URL,
  SAVE_TOUR_DAILY_URL,
  SAVE_TOUR_INFO_URL,
  SOHEAD,
  postSoa,
} from "../transport.js";

export async function checkTourDailyStep(
  page: ApiPage,
  productTourInfo: Record<string, unknown>,
  tourDailyText: string,
  saveType: 2 | 8 | 3,
  label: string,
  onProductTourInfo?: (relation: Record<string, unknown> | undefined) => void,
): Promise<Record<string, unknown>> {
  const { payload } = await postSoa(
    page,
    CHECK_TOUR_DAILY_URL,
    {
      contentType: "json",
      head: SOHEAD,
      productTourInfo,
      saveType,
      tourDaily: tourDailyText,
    },
    label,
  );
  onProductTourInfo?.(asRecord(payload.productTourInfo));
  const raw = payload?.tourDaily;
  if (!raw) {
    throw new Error(`${label}响应缺 tourDaily 字段`);
  }
  let parsed: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const idSafeRaw = raw.replace(
        /("(?:tourInfoId|previewTourInfoId|auditTourInfoId|draftTourInfoId|fromTourInfoId|tourInfoScoreId|tourDaily[A-Za-z]+Id)"\s*:\s*)(\d{16,})/g,
        '$1"$2"',
      );
      parsed = JSON.parse(idSafeRaw) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${label}响应 tourDaily 字符串解析失败：${String(e).slice(0, 200)}`);
    }
  } else {
    parsed = raw as Record<string, unknown>;
  }
  if (!parsed.tourInfoId) {
    throw new Error(`${label}响应未生成新 tourInfoId（Ack=Success 但结构空）`);
  }
  return parsed;
}

export async function calculateTourScoreStep(
  page: ApiPage,
  productTourInfo: Record<string, unknown>,
): Promise<{ aggregateScore?: number; tourInfoScores?: unknown }> {
  const { payload } = await postSoa(
    page,
    CALC_TOUR_SCORE_URL,
    {
      businessData: "{}",
      contentType: "json",
      requestHeader: { locale: "zh-CN" },
      tourInfo: productTourInfo,
    },
    "VBK 行程评分计算",
  );
  const tourInfo = payload?.tourInfo as { aggregateScore?: number; tourInfoScores?: unknown } | undefined;
  return {
    aggregateScore: tourInfo?.aggregateScore,
    tourInfoScores: tourInfo?.tourInfoScores,
  };
}

export async function saveTourDailyDetailStep(
  page: ApiPage,
  tourInfo: Record<string, unknown>,
  protocol: "draft-v2" | "legacy" = "legacy",
): Promise<Record<string, unknown>> {
  const { payload } = await postSoa(
    page,
    SAVE_TOUR_DAILY_URL,
    {
      requestHeader: { locale: "zh-CN" },
      piCategoryId: 0,
      ...(protocol === "draft-v2" ? { saveType: 2 } : {}),
      tourInfo,
    },
    "VBK 行程详情保存",
    { headers: { "content-type": "application/json;charset=UTF-8" } },
  );
  if (!payload?.tourInfo && !payload?.result && !payload?.tourInfoId) {
    throw new Error("VBK 行程详情保存响应缺 tourInfo（Ack=Success 但结构空）");
  }
  const responseTourInfo = asRecord(payload.tourInfo) ?? asRecord(payload.result) ?? payload;
  return responseTourInfo;
}

export async function saveProductTourInfoStep(
  page: ApiPage,
  tourInfo: Record<string, unknown>,
  tourDailyJson: string,
  protocol: "draft-v2" | "legacy" = "legacy",
): Promise<void> {
  const { payload } = await postSoa(
    page,
    SAVE_TOUR_INFO_URL,
    {
      contentType: "json",
      head: SOHEAD,
      tourInfo: protocol === "draft-v2" ? tourInfo : legacyProductTourInfo(tourInfo),
      saveType: protocol === "draft-v2" ? 2 : 3,
      tourDaily: tourDailyJson,
    },
    "VBK 行程关联保存",
    {
      referrer: `https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=${encodeURIComponent(String(tourInfo.productId))}&from=vbk`,
      referrerPolicy: "no-referrer-when-downgrade",
      headers: { "x-ctx-locale": "zh-CN", "x-input-locale": "zh-CN" },
    },
  );
  if (!payload) {
    throw new Error("VBK 行程关联保存响应空（Ack=Success 但 payload 为空）");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Preserve the established traffic-child association request unchanged. */
function legacyProductTourInfo(tourInfo: Record<string, unknown>): Record<string, unknown> {
  return {
    productId: tourInfo.productId,
    tourInfoId: tourInfo.tourInfoId,
    tourInfoName: tourInfo.tourInfoName ?? "",
    tourInfoDesc: tourInfo.tourInfoDesc ?? "",
    main: tourInfo.main ?? true,
    sort: tourInfo.sort ?? 0,
    draftTourInfoStatus: tourInfo.draftTourInfoStatus ?? 2,
    auditTourInfoId: tourInfo.tourInfoId,
    auditTourInfoStatus: 1,
    aggregateScore: tourInfo.aggregateScore ?? 100,
    auditStatus: tourInfo.auditStatus ?? { key: "N", value: "未提交" },
  };
}