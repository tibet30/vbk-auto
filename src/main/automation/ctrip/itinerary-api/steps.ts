/**
 * itinerary-api/steps.ts：
 *   - 6 个 soa2 接口 step 的最小包装，每个 step 接收 ApiPage + 入参，返回
 *     归一化字段或抛错（带 label / 字段名）。
 *   - 这些 step 不做任何"业务编排"（不合并 tourInfo、不调接送站、不做回读），
 *     只负责单次请求与响应解析；orchestrator.ts 用它们串起整个流程。
 */

import {
  ApiPage,
  CALC_TOUR_SCORE_URL,
  CHECK_TOUR_DAILY_URL,
  GET_DAILY_TEMPLATE_URL,
  GET_TOUR_DAILY_URL,
  GET_TOUR_INFO_LIST_URL,
  SAVE_TOUR_DAILY_URL,
  SAVE_TOUR_INFO_URL,
  SOHEAD,
  postSoa,
} from "./transport.js";

export interface FetchTourInfoIdResult {
  tourInfo: Record<string, unknown>;
  tourInfoId: string | number;
  /** 行程模板 ID（空产品 / 新建行程时用于 getDailyTemplateDetail）。缺省值由 orchestrator 决定（默认 3）。 */
  templateId?: number;
  isNew: boolean;
}

/** 空产品默认模板 ID：tourInfoList 响应未带 templateId 时使用。 */
export const DEFAULT_DAILY_TEMPLATE_ID = 3;

/**
 * getProductTourInfoList：拉取行程关联列表，返回第一个 tourInfo + 选定的
 * tourInfoId（auditTourInfoId → tourInfoId → draftTourInfoId 优先级）。空
 * 列表视为"新产品"，tourInfoId=0 由 saveTourDailyDetail 后端分配。
 *
 * templateId 取值优先级：
 *   1. payload.tourInfos[0].templateId（首个 tourInfo 自带）；
 *   2. payload.templateId（响应根级）；
 *   3. undefined（orchestrator 落到 DEFAULT_DAILY_TEMPLATE_ID）。
 */
export async function fetchTourInfoId(page: ApiPage, productId: string): Promise<FetchTourInfoIdResult> {
  const { payload } = await postSoa(
    page,
    GET_TOUR_INFO_LIST_URL,
    {
      contentType: "json",
      head: SOHEAD,
      productId: Number(productId) || productId,
    },
    "VBK 行程关联查询",
  );
  const rootTemplateIdRaw = (payload as { templateId?: unknown })?.templateId;
  const rootTemplateId = parseTemplateId(rootTemplateIdRaw);
  const tourInfos = Array.isArray(payload?.tourInfos) ? payload.tourInfos as Array<Record<string, unknown>> : [];
  if (!tourInfos.length) {
    return {
      tourInfo: {
        main: true,
        sort: 0,
        isNew: true,
        days: 0,
        fromTourInfoId: 0,
        referenceCount: 0,
        productId: Number(productId) || productId,
        tourInfoId: 0,
      },
      tourInfoId: 0,
      templateId: rootTemplateId,
      isNew: true,
    };
  }
  const first = tourInfos[0];
  const candidateId = [
    first.auditTourInfoId,
    first.tourInfoId,
    first.draftTourInfoId,
    first.previewTourInfoId,
  ].find((value) => value !== null && value !== undefined && String(value) !== "0" && String(value) !== "") as
    string | number | undefined;
  const firstTemplateIdRaw = (first as { templateId?: unknown }).templateId;
  const firstTemplateId = parseTemplateId(firstTemplateIdRaw);
  return {
    tourInfo: first,
    tourInfoId: candidateId ?? 0,
    templateId: firstTemplateId ?? rootTemplateId,
    isNew: !candidateId,
  };
}

export interface FetchDailyTemplateDetailResult {
  /** 模板结构（含模板字段定义 / 模板 days 等），最终并入 newTourInfo.template。 */
  template: Record<string, unknown>;
  /** 模板 ID（响应里 template.templateId 或 root templateId 缺省 fallback 到入参）。 */
  templateId: number;
  source: string;
}

/**
 * getDailyTemplateDetail：拉取空产品 / 新建行程用的模板结构。
 *  - 仅在 existingTourInfoId=0（产品尚未有任何行程）时调用，作用是补齐
 *    newTourInfo.template / templateId 字段，让 checkTourDaily(saveType=8/3)
 *    能识别到模板，避免后端把新建行程当作「空对象」拒绝；
 *  - requestHeader.locale 必须 zh-CN（与 getTourDailyDetail 保持一致）；
 *  - templateId 来自 getProductTourInfoList 响应，缺省 3；
 *  - contentType 必须 "json"（与 calculateTourInfoScore 同型）。
 *
 * 严格失败：响应缺 template 或 template 为空对象（无任何字段）→ 直接抛错，
 * 让 orchestrator 透传到调用方，不要继续把空 template 写进 newTourInfo
 * 触发后端二次失败。
 *
 * 返回的 template 字段在 orchestrator 里直接赋给 newTourInfo.template，
 * templateId 同时写入 newTourInfo.templateId / productTourInfo.templateId。
 */
export async function fetchDailyTemplateDetail(
  page: ApiPage,
  templateId: number,
): Promise<FetchDailyTemplateDetailResult> {
  const { payload } = await postSoa(
    page,
    GET_DAILY_TEMPLATE_URL,
    {
      requestHeader: { locale: "zh-CN" },
      templateId,
      contentType: "json",
    },
    "VBK 行程模板查询",
  );
  const rawTemplate = (payload as { template?: unknown })?.template;
  if (!rawTemplate || typeof rawTemplate !== "object" || Array.isArray(rawTemplate)) {
    throw new Error("VBK 行程模板查询响应缺 template 字段");
  }
  const template = rawTemplate as Record<string, unknown>;
  if (Object.keys(template).length === 0) {
    throw new Error("VBK 行程模板查询响应 template 为空对象");
  }
  const payloadTemplateIdRaw = (payload as { templateId?: unknown })?.templateId;
  const payloadTemplateId = parseTemplateId(payloadTemplateIdRaw);
  const templateTemplateIdRaw = (template as { templateId?: unknown }).templateId;
  const templateTemplateId = parseTemplateId(templateTemplateIdRaw);
  return {
    template,
    templateId: payloadTemplateId ?? templateTemplateId ?? templateId,
    source: "primary",
  };
}

/**
 * 把后端可能返回的 templateId（number / 数字字符串 / 0 / null）归一为
 * 正整数 number；无效或 0/falsy → undefined，调用方自行 fallback。
 */
function parseTemplateId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export interface FetchTourDailyDetailResult {
  tourInfo: Record<string, unknown> | null;
  descriptions: unknown[];
  source: string;
}

/**
 * getTourDailyDetail：拉取行程详情。空响应（tourInfo=null）→ 视为新产品，
 * 由调用方在合并阶段填入默认结构。
 */
export async function fetchTourDailyDetail(
  page: ApiPage,
  tourInfoId: string | number,
): Promise<FetchTourDailyDetailResult> {
  const { payload } = await postSoa(
    page,
    GET_TOUR_DAILY_URL,
    {
      requestHeader: { locale: "zh-CN" },
      tourInfoId: String(tourInfoId),
      departureDate: "2024-07-12",
      businessData: "",
      contentType: "json",
    },
    "VBK 行程详情查询",
  );
  const tourInfo = (payload?.tourInfo as Record<string, unknown> | undefined) ?? null;
  const descriptions = Array.isArray(tourInfo?.tourDailyDescriptions)
    ? tourInfo.tourDailyDescriptions as unknown[]
    : [];
  return { tourInfo, descriptions, source: "primary" };
}

/**
 * checkTourDaily：通用包装。响应 text 字段可能是字符串化的 JSON，需要解析；
 * Ack=Success 但响应缺 tourDaily 时抛错；saveType=3 还要求响应里有
 * tourInfoId（saveType=8 是预览，不强制）。
 */
export async function checkTourDailyStep(
  page: ApiPage,
  productTourInfo: Record<string, unknown>,
  tourDailyText: string,
  saveType: 8 | 7 | 3,
  label: string,
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
  const raw = payload?.tourDaily;
  if (!raw) {
    throw new Error(`${label}响应缺 tourDaily 字段`);
  }
  let parsed: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const idSafeRaw = raw.replace(
        /("(?:tourInfoId|previewTourInfoId|auditTourInfoId|draftTourInfoId|tourInfoScoreId|tourDaily[A-Za-z]+Id)"\s*:\s*)(\d{16,})/g,
        '$1"$2"',
      );
      parsed = JSON.parse(idSafeRaw) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${label}响应 tourDaily 字符串解析失败：${String(e).slice(0, 200)}`);
    }
  } else {
    parsed = raw as Record<string, unknown>;
  }
  if (!parsed.tourInfoId && (saveType === 3 || saveType === 7)) {
    throw new Error(`${label}响应未生成新 tourInfoId（Ack=Success 但结构空）`);
  }
  return parsed;
}

/**
 * calculateTourInfoScore：评分计算。仅诊断用，返回 aggregateScore 与
 * tourInfoScores，orchestrator 把它回写到 checked8 后再走 saveType=3。
 */
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

/**
 * saveTourDailyDetail：行程详情保存。
 *  - Ack=Success 但响应缺 tourInfo / result / tourInfoId → 视为结构空失败
 *    （防止后端悄悄吃掉请求）；
 *  - 后端某些路径只回 tourInfoId（顶层），不算失败；orchestrator 取
 *    savedTourInfoId 时仍以 checkTourDaily(saveType=3) 响应里的 tourInfoId
 *    为准，这里只负责"不抛错"。
 */
export async function saveTourDailyDetailStep(
  page: ApiPage,
  tourInfo: Record<string, unknown>,
): Promise<void> {
  const { payload } = await postSoa(
    page,
    SAVE_TOUR_DAILY_URL,
    {
      requestHeader: { locale: "zh-CN" },
      piCategoryId: 0,
      tourInfo,
    },
    "VBK 行程详情保存",
    { headers: { "content-type": "application/json;charset=UTF-8" } },
  );
  if (!payload?.tourInfo && !payload?.result && !payload?.tourInfoId) {
    throw new Error("VBK 行程详情保存响应缺 tourInfo（Ack=Success 但结构空）");
  }
}

/**
 * saveProductTourInfo：行程关联保存。tourInfo 只取必要字段（后端只读这一组），
 * auditTourInfoId 用本次写完拿到的 savedTourInfoId（orchestrator 在外层注入）。
 */
export async function saveProductTourInfoStep(
  page: ApiPage,
  tourInfo: Record<string, unknown>,
  tourDailyJson: string,
): Promise<void> {
  const { payload } = await postSoa(
    page,
    SAVE_TOUR_INFO_URL,
    {
      contentType: "json",
      head: SOHEAD,
      tourInfo: {
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
      },
      saveType: 3,
      tourDaily: tourDailyJson,
    },
    "VBK 行程关联保存",
  );
  if (!payload) {
    throw new Error("VBK 行程关联保存响应空（Ack=Success 但 payload 为空）");
  }
}
