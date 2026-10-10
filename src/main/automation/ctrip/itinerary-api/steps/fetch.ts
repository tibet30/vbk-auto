/**
 * itinerary-api/steps/fetch.ts：只读 step（拉取）——
 *   - fetchTourInfoId：getProductTourInfoList → 第一个 tourInfo + 选定的
 *     tourInfoId（formal tourInfoId 优先，缺则 isNew=true）；
 *   - fetchDailyTemplateDetail：getDailyTemplateDetail → 模板结构 + templateId；
 *     响应缺 template / template 为空对象 → 直接抛错，让 orchestrator 透传；
 *   - fetchTourDailyDetail：getTourDailyDetail → tourInfo + tourDailyDescriptions；
 *     空响应（tourInfo=null）→ 视为新产品，由调用方在合并阶段填入默认结构；
 *   - parseTemplateId：把后端可能返回的 templateId（number / 数字字符串 / 0 /
 *     null）归一为正整数 number；无效 → undefined。
 *
 * templateId 取值优先级（fetchTourInfoId）：
 *   1. payload.tourInfos[0].templateId（首个 tourInfo 自带）；
 *   2. payload.templateId（响应根级）；
 *   3. undefined（orchestrator 落到 DEFAULT_DAILY_TEMPLATE_ID = 3）。
 */

import {
  ApiPage,
  GET_DAILY_TEMPLATE_URL,
  GET_TOUR_DAILY_URL,
  GET_TOUR_INFO_LIST_URL,
  SOHEAD,
  postSoa,
} from "../transport.js";

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

export interface FetchTourDailyDetailResult {
  tourInfo: Record<string, unknown> | null;
  descriptions: unknown[];
  source: string;
}

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
 * 把后端可能返回的 templateId（number / 数字字符串 / 0 / null）归一为
 * 正整数 number；无效或 0/falsy → undefined，调用方自行 fallback。
 */
export function parseTemplateId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}