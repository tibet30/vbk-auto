import { RECOMMENDATION_CATEGORIES } from "../automation/schema/schema.js";
import { normaliseHotelTier } from "../../shared/hotel-tiers.js";

function textValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

const ACTIVITY_TYPES = new Set(["transport", "visit", "meal", "hotel", "free", "other"]);

function normaliseRecommendationItem(value: unknown): { category: string; text: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const category = textValue(record.category);
  const text = textValue(record.text);
  if (!category || !text) return undefined;
  if (!(RECOMMENDATION_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return { category, text };
}

function normaliseRecommendations(value: unknown): Array<{ category: string; text: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length !== 3) return undefined;
  const items: Array<{ category: string; text: string }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = normaliseRecommendationItem(entry);
    if (!item) return undefined;
    if (seen.has(item.category)) return undefined;
    seen.add(item.category);
    items.push(item);
  }
  return items;
}

function normaliseActivity(value: unknown): { time: string; title: string; detail: string; type: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const time = textValue(record.time);
  const title = textValue(record.title) || textValue(record.name);
  const detail = textValue(record.detail);
  if (!time || !title || !detail) return undefined;
  const rawType = textValue(record.type);
  const type = ACTIVITY_TYPES.has(rawType) ? rawType : "other";
  return { time, title, detail, type };
}

export function normalisePresentation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const highlights = Array.isArray(record.highlights) ? record.highlights.map(textValue).filter(Boolean) : [];
  const recommendation = textValue(record.recommendation) || textValue(record.description) || textValue(record.subtitle) || textValue(record.productName);
  const features = textValue(record.features) || highlights.join("\n") || textValue(record.highlightsMore);
  if (!recommendation || !features) return undefined;
  const cover = record.cover && typeof record.cover === "object" && !Array.isArray(record.cover) ? record.cover : undefined;
  const recommendations = normaliseRecommendations(record.recommendations);
  return {
    recommendationCategory: textValue(record.recommendationCategory) || "优选行程",
    recommendation,
    features,
    ...(recommendations ? { recommendations } : {}),
    ...(cover ? { cover } : {}),
  };
}

function normaliseMeals(value: unknown) {
  if (typeof value === "string") return { summary: value, descriptions: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { summary: "餐食以实际确认单为准", descriptions: undefined };
  const record = value as Record<string, unknown>;
  const entries = [
    ["早餐", textValue(record.breakfast)],
    ["午餐", textValue(record.lunch)],
    ["晚餐", textValue(record.dinner)],
  ].map(([label, detail]) => `${label}${detail || "待确认"}`);
  return { summary: entries.join("；"), descriptions: entries };
}

export function normaliseItinerary(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const days = value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const rawActivities = Array.isArray(record.activities)
      ? record.activities.filter((activity): activity is Record<string, unknown> => Boolean(activity) && typeof activity === "object" && !Array.isArray(activity))
      : [];
    const activities = rawActivities.map(normaliseActivity).filter((activity): activity is { time: string; title: string; detail: string; type: string } => Boolean(activity));
    const spots = Array.isArray(record.spots)
      ? record.spots.map(textValue).filter(Boolean)
      : rawActivities.map((activity) => textValue(activity.title) || textValue(activity.name)).filter((name) => name && !/接站|接机|送站|送机|早餐|午餐|晚餐|入住|酒店/.test(name));
    const activityDescription = activities
      .map((activity) => [activity.time, activity.title, activity.detail].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("；");
    const meals = normaliseMeals(record.meals);
    const title = textValue(record.title) || `第 ${index + 1} 天行程`;
    const description = textValue(record.description) || [textValue(record.summary), activityDescription].filter(Boolean).join("。") || title;
    const hotel = textValue(record.hotel) || textValue(record.stay);
    return [{
      day: Number.isInteger(record.day) && Number(record.day) > 0 ? Number(record.day) : index + 1,
      title,
      spots,
      description,
      hotel,
      meals: meals.summary,
      ...(meals.descriptions ? { mealDescriptions: meals.descriptions } : {}),
      ...(hotel ? { hotelDescription: hotel } : {}),
      ...(activities.length ? { activities } : {}),
    }];
  });
  return days.length ? days : undefined;
}

export function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normaliseCommercialPricing(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const adult = positiveNumber(record.adult);
  const child = positiveNumber(record.child);
  const minimumTravelers = positiveInteger(record.minimumTravelers);
  if (adult === undefined || adult <= 0 || child === undefined || minimumTravelers === undefined) return undefined;
  const currency = record.currency === "CNY" || record.currency === undefined ? "CNY" : undefined;
  if (!currency) return undefined;
  const costSource = record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? record.cost as Record<string, unknown> : undefined;
  const cost = costSource ? (() => {
    const adultCost = positiveNumber(costSource.adult);
    const childCost = positiveNumber(costSource.child);
    if (adultCost === undefined || childCost === undefined) return undefined;
    const single = positiveNumber(costSource.singleSupplement) ?? 0;
    const bed = positiveNumber(costSource.childBed) ?? 0;
    return { adult: adultCost, child: childCost, singleSupplement: single, childBed: bed };
  })() : undefined;
  const out: Record<string, unknown> = { currency, adult, child, minimumTravelers };
  if (cost) out.cost = cost;
  return out;
}

function normaliseCommercialInventory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const start = typeof record.startDate === "string" ? record.startDate : "";
  const end = typeof record.endDate === "string" ? record.endDate : "";
  const quota = positiveInteger(record.dailyQuota);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !quota) return undefined;
  if (new Date(start) > new Date(end)) return undefined;
  return { startDate: start, endDate: end, dailyQuota: quota };
}

function normaliseCommercialRelease(value: unknown, options?: NormaliseReleaseOptions) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ceiling = positiveNumber(record.publicPriceCeiling);
  if (!ceiling) return undefined;
  // 通用语义：默认**保留** release.submitReview / publishAfterApproval；
  // 这是数据库启动归一、历史 fixture 解析、读取已人工显式打开的 release
  // 时的安全路径——一次 reload 不应把运营/VBK 标记的发布态悄悄翻成 false。
  // AI / 自动写入路径必须显式传 safeRelease=true 来强制 draft-only。
  const safe = options?.safeRelease === true;
  const submitReview = safe ? false : record.submitReview === true;
  const publishAfterApproval = safe ? false : record.publishAfterApproval === true;
  const retriesRaw = positiveInteger(record.publicAuditRetries);
  const publicAuditRetries = retriesRaw && retriesRaw >= 1 && retriesRaw <= 10 ? retriesRaw : 3;
  return {
    submitReview,
    publishAfterApproval,
    publicPriceCeiling: ceiling,
    publicAuditRetries,
  };
}

export interface NormaliseReleaseOptions {
  /**
   * 强制 release 进入 draft-only：submitReview / publishAfterApproval 一律为 false。
   * AI / 自动写入路径必须显式传 true，否则会把已经人工 / VBK 打开的发布态默默清零。
   * 数据库 startup normalize 默认不传，保留历史 / 人工 release 标记。
   */
  safeRelease?: boolean;
}

/** @deprecated use {@link NormaliseReleaseOptions.safeRelease} instead. */
export type NormaliseOptions = NormaliseReleaseOptions;

export function normaliseProductDraft(product: Record<string, unknown>, options?: NormaliseOptions) {
  const result = structuredClone(product);
  const presentation = normalisePresentation(result.presentation);
  const itinerary = normaliseItinerary(result.itinerary);
  if (presentation) result.presentation = presentation;
  if (itinerary) result.itinerary = itinerary;
  if (result.operations && typeof result.operations === "object" && !Array.isArray(result.operations)) {
    const operations = { ...(result.operations as Record<string, unknown>) };
    if (!(["charter", "shared", "none"] as unknown[]).includes(operations.transport)) delete operations.transport;
    if (!textValue(operations.pickupCity)) delete operations.pickupCity;
    if (typeof operations.reusePickupForDropoff !== "boolean") delete operations.reusePickupForDropoff;
    if (operations.hotelSource !== "nonPlatform") delete operations.hotelSource;
    // 酒店档次：使用统一白名单；旧 /-5 自动被 normaliseHotelTier 纠正为 /-38。
    const normalisedTier = normaliseHotelTier(operations.hotelTier);
    if (normalisedTier) operations.hotelTier = normalisedTier;
    else delete operations.hotelTier;
    if (typeof operations.mealsIncluded !== "boolean") delete operations.mealsIncluded;
    if (Object.keys(operations).length) result.operations = operations; else delete result.operations;
  }
  if (result.commercial && typeof result.commercial === "object" && !Array.isArray(result.commercial)) {
    const commercial = { ...(result.commercial as Record<string, unknown>) };
    if (!textValue(commercial.packageName)) delete commercial.packageName;
    if (!commercial.terms || typeof commercial.terms !== "object" || Array.isArray(commercial.terms)) delete commercial.terms;
    const pricing = normaliseCommercialPricing(commercial.pricing);
    if (pricing) commercial.pricing = pricing; else delete commercial.pricing;
    const inventory = normaliseCommercialInventory(commercial.inventory);
    if (inventory) commercial.inventory = inventory; else delete commercial.inventory;
    const release = normaliseCommercialRelease(commercial.release, { safeRelease: options?.safeRelease });
    if (release) commercial.release = release; else delete commercial.release;
    if (Object.keys(commercial).length) result.commercial = commercial; else delete result.commercial;
  }
  return result;
}