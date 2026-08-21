import { VBK_RECOMMENDATION_CATEGORIES } from "../domain/product/recommendation-categories.js";
import { defaultCommercialInventory } from "./commercial-defaults.js";
import { normaliseHotelTier } from "../../shared/hotel-tiers.js";

/**
 * 产品草稿归一化。
 *
 * AI 输出、外部导入、数据库启动迁移都会先把产品对象喂给 `normaliseProductDraft`，
 * 再让上层继续使用；目的是把不合法字段静默剔除、把别名/缺字段归位到白名单。
 *
 * 几个常被踩到的坑：
 *  - release 默认是草稿安全状态（`safeRelease` 不传 → 保留人工/VBK 打开的开关）；
 *  - 酒店档次遇到旧的 "-5" 会被纠正到 "-38"；
 *  - itinerary 推荐语的三条强制走白名单 + 去重。
 *
 * 主要导出：
 *  - normaliseProductDraft：顶层入口；深拷贝 + 逐字段归一化
 *  - normalisePresentation / normaliseItinerary：presentation / itinerary 子结构归一化
 *  - NormaliseReleaseOptions：safeRelease 选项，控制 release 是否强制 draft-only
 */

function textValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

function positiveNumberValue(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function positiveIntegerValue(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function normalisePoiId(value: unknown): number | null {
  return positiveIntegerValue(value) ?? null;
}

const ACTIVITY_TYPES = new Set(["transport", "visit", "meal", "hotel", "free", "other"]);

function normaliseRecommendationItem(value: unknown): { category: string; text: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const category = textValue(record.category);
  const text = textValue(record.text);
  if (!category || !text) return undefined;
  if (!(VBK_RECOMMENDATION_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return { category, text };
}

/**
 * 推荐语数组校验：长度必须为 3、每条 category/text 非空且 category 在白名单、互不重复；
 * 任一条不合规返回 undefined（调用方丢掉整个 recommendations 字段）。
 */
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

/**
 * 单条行程活动（time/title/detail/type）归一化：
 *   - type 不在白名单 → 退化为 "other"；
 *   - title 接受 record.name 别名；
 *   - 缺 time/title/detail 任一 → 返回 undefined。
 */
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

/**
 * 归一化产品 presentation（推荐语 / 产品特点 / 三条推荐）。
 *  - 推荐语接受 recommendation / description / subtitle / productName 多种别名；
 *  - features 接受 features / highlights / highlightsMore；
 *  - 三条推荐必须长度恰好为 3、类别在白名单、互不重复，否则整个 recommendations 字段被剔除；
 *  - 返回 undefined 表示该结构不可用，调用方应当丢弃。
 */
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

/**
 * 餐食归一化：接受 string 或 { breakfast/lunch/dinner } 对象，
 * 统一输出 summary（中文拼接）+ 可选 descriptions（三餐逐条）。
 */
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

/**
 * 归一化产品行程（按天列表）。
 *  - 接受 activities 数组 / spots 数组 / 老的散落字段；
 *  - 一天的活动会被合并成 description；spots 过滤掉接团/送站等非景点词；
 *  - 餐食会被重写成 `早餐…；午餐…；晚餐…` summary 形式；
 *  - 返回 undefined 表示该结构不可用。
 */
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
      ? record.spots.map((spot) => typeof spot === "string" ? { name: spot.trim(), poiName: null, poiId: null } : spot && typeof spot === "object" ? { name: textValue((spot as any).name) || textValue((spot as any).poiName), poiName: textValue((spot as any).poiName) || null, poiId: normalisePoiId((spot as any).poiId) } : null).filter((spot): spot is { name: string; poiName: string | null; poiId: number | null } => Boolean(spot?.name))
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

/**
 * 把 unknown 转成非负有限数字；非法或负数返回 undefined。
 * 用于 pricing.cost.* / pricing.adult / release.publicPriceCeiling 等金额字段。
 */
export function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
/**
 * 把 unknown 转成正整数（> 0）；非整数 / 非正返回 undefined。
 * 用于 inventory.dailyQuota / release.publicAuditRetries 等。
 */
function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 商业定价归一化：adult > 0、child ≥ 0、minimumTravelers 为正整数、currency 仅允许 CNY；
 * 含 cost.{adult, child} 与可选 singleSupplement / childBed。
 * 任一关键字段不合规 → 返回 undefined。
 */
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

/**
 * 库存归一化：startDate / endDate 必须是 YYYY-MM-DD，dailyQuota 为正整数，
 * 且 startDate 不晚于 endDate，否则返回 undefined。
 */
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

/**
 * Release 归一化：
 *   - publicPriceCeiling 必填（>0）；
 *   - 默认保留人工/VBK 已打开的 submitReview / publishAfterApproval；
 *   - options.safeRelease=true 时强制 draft-only（AI / 自动写入路径）；
 *   - publicAuditRetries 钳制到 1..10，超出回落到 3。
 */
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

/**
 * 产品草稿顶层归一化入口。
 *
 * 会深克隆入参再修改，避免污染上游数据。归一化后无法识别的字段会被静默剔除；
 * 调用方拿到的是「尽可能合法但不一定完整」的对象——仍需在下游做必填校验。
 *
 * @param product 原始产品对象（任意来源：AI 输出、数据库读取、import）
 * @param options.safeRelease 传 true 时把 release 强制为 draft-only（仅 AI/自动写入路径需要）
 */
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
    if (!operations.vehicleResource || typeof operations.vehicleResource !== "object" || Array.isArray(operations.vehicleResource)) {
      operations.vehicleResource = {};
    } else {
      const vehicle = operations.vehicleResource as Record<string, unknown>;
      const days = result.basicInfo && typeof result.basicInfo === "object" && !Array.isArray(result.basicInfo)
        ? positiveIntegerValue((result.basicInfo as Record<string, unknown>).days) || 1
        : 1;
      const requestedTotalCost = positiveNumberValue(vehicle.requestedTotalCost)
        || (positiveNumberValue(vehicle.requestedDailyCost)
          ? positiveNumberValue(vehicle.requestedDailyCost)! * days
          : undefined);
      operations.vehicleResource = {
        ...(requestedTotalCost ? { requestedTotalCost } : {}),
        ...((vehicle.requestedTotalCostCleared === true || vehicle.requestedDailyCostCleared === true)
          ? { requestedTotalCostCleared: true }
          : {}),
        ...(positiveIntegerValue(vehicle.resourceGroupId) ? { resourceGroupId: positiveIntegerValue(vehicle.resourceGroupId) } : {}),
        ...(textValue(vehicle.resourceGroupName) ? { resourceGroupName: textValue(vehicle.resourceGroupName) } : {}),
        ...(positiveIntegerValue(vehicle.serviceHoursPerDay) ? { serviceHoursPerDay: positiveIntegerValue(vehicle.serviceHoursPerDay) } : {}),
        ...(positiveIntegerValue(vehicle.serviceKilometersPerDay) ? { serviceKilometersPerDay: positiveIntegerValue(vehicle.serviceKilometersPerDay) } : {}),
      };
    }
    if (Object.keys(operations).length) result.operations = operations; else delete result.operations;
  }
  if (result.commercial && typeof result.commercial === "object" && !Array.isArray(result.commercial)) {
    const commercial = { ...(result.commercial as Record<string, unknown>) };
    if (!textValue(commercial.packageName)) delete commercial.packageName;
    if (!commercial.terms || typeof commercial.terms !== "object" || Array.isArray(commercial.terms)) delete commercial.terms;
    const pricing = normaliseCommercialPricing(commercial.pricing);
    if (pricing) commercial.pricing = pricing; else delete commercial.pricing;
    const inventory = normaliseCommercialInventory(commercial.inventory);
    commercial.inventory = inventory ?? defaultCommercialInventory();
    const release = normaliseCommercialRelease(commercial.release, { safeRelease: options?.safeRelease });
    if (release) commercial.release = release; else delete commercial.release;
    if (Object.keys(commercial).length) result.commercial = commercial; else delete result.commercial;
  }
  return result;
}
