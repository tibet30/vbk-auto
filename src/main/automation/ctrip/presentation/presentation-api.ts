import {
  vbkSessionRequest,
  type VbkSessionRequestBrowser,
  type VbkSessionRequestResult,
} from "../../../infrastructure/vbk-session-request.js";
import { formatProductFeaturesHtml, productFeaturesPlainText } from "../../../domain/product/features-rich-text.js";
import { buildRecommendationReasonsPlan, type RecommendationPlanStep } from "./recommendations.js";
import { readProductIdFromVbkUrl } from "./cover-bind.js";
import { PresentationSensitiveWordsError } from "./save-monitor.js";
import { findVbkCopyBadCase } from "../../../planning/vbk-copy-policy.js";

const SOA_15638 = "https://online.ctrip.com/restapi/soa2/15638";
const CREATE_PRODUCT_DRAFT_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20698/createProductDraft";

interface ProductDescriptionInfo {
  pmRcmdItems?: Array<Record<string, any>>;
  productDesc?: Record<string, any>;
  productDescNew?: Record<string, any>;
  productDescNewRegions?: Array<Record<string, any>>;
  addInfoCode?: unknown;
}

export interface PresentationApiResult {
  productId: number;
  recommendationCount: number;
  featuresSaved: boolean;
  savedWith: "presentation-api";
}

export async function savePresentationViaApi(
  page: VbkSessionRequestBrowser & { url(): string },
  presentation: any,
  explicitProductId?: number,
): Promise<PresentationApiResult> {
  const productId = explicitProductId ?? readProductIdFromVbkUrl(page.url());
  if (!Number.isInteger(productId) || productId <= 0) throw new Error("VBK 产品 ID必须是正整数。");
  const recommendations = buildRecommendationReasonsPlan(presentation.recommendations);
  assertPresentationCopyAllowed(presentation.recommendation, "recommendation", "推荐语");
  const featuresHtml = formatProductFeaturesHtml(presentation.features);
  if (!featuresHtml) throw new Error("产品图文缺少产品特色 HTML，已停止接口保存。");
  assertPresentationCopyAllowed(productFeaturesPlainText(featuresHtml), "features", "产品特色");

  const [categoryMap, current] = await Promise.all([
    loadRecommendationCategories(page),
    loadDescriptionInfo(page, productId),
  ]);
  await checkPresentationSensitiveWords(page, productId, presentation, recommendations, featuresHtml);
  await createDescriptionDraft(page, productId);

  const pmRcmdItems = buildPmRcmdItems(recommendations, categoryMap, current.pmRcmdItems ?? []);
  const body = {
    dto: {
      productId,
      saveType: 3,
      pmRcmdItems,
      productDesc: {
        ...(current.productDesc ?? {}),
        productId,
        productDesc: featuresHtml,
        isBindTravelInfo: true,
      },
      productDescNew: null,
      addInfoCode: current.addInfoCode,
    },
  };
  const saveResult = await request(page, {
    endpoint: `${SOA_15638}/savedescriptioninfo`,
    body,
    errorLabel: "产品图文接口保存",
  });
  assertSaveSuccess(saveResult, "产品图文接口保存");

  const saved = await confirmDescriptionInfo(page, productId, recommendations, featuresHtml);
  return {
    productId,
    recommendationCount: saved.pmRcmdItems?.length ?? 0,
    featuresSaved: true,
    savedWith: "presentation-api",
  };
}

function assertPresentationCopyAllowed(value: unknown, path: string, label: string): void {
  const copyBadCase = findVbkCopyBadCase(value, path);
  if (!copyBadCase) return;
  throw new Error(
    `产品图文${label}命中 VBK 文案黑名单「${copyBadCase.term}」：${copyBadCase.reason}；请改写为「${copyBadCase.alternatives.join("」或「")}」。`,
  );
}

async function loadRecommendationCategories(page: VbkSessionRequestBrowser): Promise<Map<string, number>> {
  const result = await request(page, {
    endpoint: `${SOA_15638}/getpmrcmdcategory.json`,
    body: {},
    errorLabel: "读取产品图文推荐理由分类",
  });
  assertAckSuccess(result, "读取产品图文推荐理由分类");
  const categories = asRecord(result.payload)?.pmRcmdCategories;
  if (!Array.isArray(categories)) throw new Error("产品图文推荐理由分类回读为空。");
  const map = new Map<string, number>();
  for (const item of categories) {
    const record = asRecord(item);
    const name = text(record?.pmRcmdCategoryName);
    const id = Number(record?.pmRcmdCategoryId);
    if (name && Number.isInteger(id) && id > 0) map.set(name, id);
  }
  return map;
}

async function loadDescriptionInfo(
  page: VbkSessionRequestBrowser,
  productId: number,
): Promise<ProductDescriptionInfo> {
  const result = await request(page, {
    endpoint: `${SOA_15638}/getdescriptionInfo`,
    body: { productId },
    errorLabel: "读取产品图文",
  });
  assertAckSuccess(result, "读取产品图文");
  return (asRecord(asRecord(result.payload)?.info) ?? {}) as ProductDescriptionInfo;
}

async function checkPresentationSensitiveWords(
  page: VbkSessionRequestBrowser,
  productId: number,
  presentation: any,
  recommendations: RecommendationPlanStep[],
  featuresHtml: string,
): Promise<void> {
  const content = [
    presentation.recommendation,
    productFeaturesPlainText(featuresHtml),
    ...recommendations.map((item) => item.text),
  ].map(text).filter(Boolean).join("\n");
  if (!content) return;
  const result = await request(page, {
    endpoint: `${SOA_15638}/checkSensitiveWord`,
    body: { content, productId },
    errorLabel: "产品图文敏感词检查",
  });
  const words = readSensitiveWords(result.payload);
  if (words.length > 0) throw new PresentationSensitiveWordsError(words, result.status);
}

async function createDescriptionDraft(page: VbkSessionRequestBrowser, productId: number): Promise<void> {
  const result = await request(page, {
    endpoint: CREATE_PRODUCT_DRAFT_ENDPOINT,
    body: { productId, module: "desc" },
    errorLabel: "创建产品图文草稿",
  });
  assertAckSuccess(result, "创建产品图文草稿");
}

function buildPmRcmdItems(
  recommendations: RecommendationPlanStep[],
  categoryMap: Map<string, number>,
  existing: Array<Record<string, any>>,
): Array<Record<string, any>> {
  return recommendations.map((item, index) => {
    const categoryId = categoryMap.get(item.category);
    if (!categoryId) throw new Error(`VBK 未返回推荐理由分类「${item.category}」的 ID。`);
    const previous = existing[index] ?? existing.find((entry) => Number(entry.pmRcmdCategoryId) === categoryId) ?? {};
    return {
      ...previous,
      pmRcmdCategoryId: categoryId,
      pmRcmdCategoryName: item.category,
      rcmdDesc: item.text.trim(),
      sortOrder: index + 1,
    };
  });
}

async function confirmDescriptionInfo(
  page: VbkSessionRequestBrowser,
  productId: number,
  recommendations: RecommendationPlanStep[],
  featuresHtml: string,
): Promise<ProductDescriptionInfo> {
  const saved = await loadDescriptionInfo(page, productId);
  const items = Array.isArray(saved.pmRcmdItems) ? saved.pmRcmdItems : [];
  for (const expected of recommendations) {
    if (!items.some((item) => text(item.rcmdDesc) === expected.text.trim())) {
      throw new Error(`产品图文推荐理由回读不一致：缺少「${expected.text.trim()}」。`);
    }
  }
  const savedText = productFeaturesPlainText(saved.productDesc?.productDesc);
  const expectedText = productFeaturesPlainText(featuresHtml);
  if (!savedText.includes(expectedText.slice(0, Math.min(40, expectedText.length)))) {
    throw new Error("产品图文产品特色回读不一致：接口保存后未读到目标富文本。");
  }
  return saved;
}

async function request(
  page: VbkSessionRequestBrowser,
  args: { endpoint: string; body: Record<string, unknown>; errorLabel: string },
): Promise<VbkSessionRequestResult> {
  return vbkSessionRequest(page, {
    ...args,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    includeCidQuery: true,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: "https://vbooking.ctrip.com/",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
}

function assertSaveSuccess(result: VbkSessionRequestResult, label: string): void {
  assertAckSuccess(result, label);
  const payload = asRecord(result.payload);
  if (payload?.success !== true) {
    const message = text(payload?.checkErrMsg) || text(payload?.errorMsg) || text(payload?.message);
    throw new Error(`${label}失败：接口未返回 success=true${message ? `：${message}` : ""}`);
  }
}

function assertAckSuccess(result: VbkSessionRequestResult, label: string): void {
  if (result.status < 200 || result.status >= 300) throw new Error(`${label}失败：HTTP ${result.status}`);
  const payload = asRecord(result.payload);
  const ack = text(asRecord(payload?.ResponseStatus)?.Ack);
  if (ack && ack !== "Success") {
    const detail = text(payload?.checkErrMsg) || text(payload?.errorMsg) || text(payload?.message);
    throw new Error(`${label}失败：Ack=${ack}${detail ? `：${detail}` : ""}`);
  }
}

function readSensitiveWords(payload: unknown): string[] {
  const raw = asRecord(payload)?.sensitiveWords ?? asRecord(payload)?.SensitiveWords ?? [];
  return Array.isArray(raw) ? raw.map(text).filter(Boolean) : [];
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}
