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
  /** True only when the server returned an empty association list. */
  emptyAssociation?: boolean;
}

/** 空产品默认模板 ID：tourInfoList 响应未带 templateId 时使用。 */
export const DEFAULT_DAILY_TEMPLATE_ID = 3;

/**
 * getProductTourInfoList：拉取行程关联列表，返回第一个 tourInfo + 选定的
 * tourInfoId（formal tourInfoId 优先）用于读取既有详情。草稿写入的目标版本
 * 由 orchestrator 从 draft/preview 显式关联字段决定，不能用 audit ID 推断。
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
  if (!Array.isArray(payload?.tourInfos)) throw new Error("VBK 行程关联查询响应缺 tourInfos，未判定为首建空草稿。");
  const tourInfos = payload.tourInfos as Array<Record<string, unknown>>;
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
      emptyAssociation: true,
    };
  }
  const first = tourInfos[0];
  const candidateId = [
    first.tourInfoId,
    first.draftTourInfoId,
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
 *  - 仅服务端明确返回空关联列表时使用此首建模板；未知版本关系 fail closed；
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
 * Ack=Success 但响应缺 tourDaily 时抛错。已验证的正常“存为草稿”流程只
 * 使用已采样的 saveType=2；响应中的详情 ID 由编排层结合关联版本关系处理。
 */
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

/**
 * calculateTourInfoScore：旧行程工具的评分计算。当前母产品草稿保存不调用
 * 此接口；保留导出供已验证的独立协议调用方使用。
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
 *  - 后端某些路径只回 tourInfoId（顶层），不算失败；草稿编排会以关联列表
 *    的 draftTourInfoId 严格核对该值。
 */
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

/**
 * saveProductTourInfo：行程关联保存。正常“存为草稿”会保留关联列表返回的
 * formal/draft/audit/preview ID 和状态；严禁改写 audit、formal 或 preview 指针。
 */
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
