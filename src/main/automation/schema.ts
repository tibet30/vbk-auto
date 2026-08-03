// @ts-nocheck
import { z } from "zod";
import { HOTEL_TIER_VALUES } from "../../shared/hotel-tiers.js";

const itineraryDaySchema = z.object({
  day: z.number().int().positive(),
  title: z.string().min(1),
  spots: z.array(z.string().min(1)).default([]),
  description: z.string().default(""),
  hotel: z.string().default(""),
  meals: z.string().default(""),
  mealDescriptions: z.array(z.string().min(1)).length(3).optional(),
  hotelDescription: z.string().default(""),
  activities: z.array(z.object({
    time: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().min(1),
    type: z.enum(["transport", "visit", "meal", "hotel", "free", "other"]).default("other"),
  })).optional(),
});

// VBK 后台「推荐理由」分类白名单，共 15 项，顺序与 VBK 下拉一致。
export const RECOMMENDATION_CATEGORIES = [
  "优选行程",
  "服务保障",
  "贴心赠送",
  "精选酒店",
  "缤纷景点",
  "特色美食",
  "度假首选",
  "超值赠送",
  "五星精选",
  "限时秒杀",
  "尊享入住",
  "大牌驾到",
  "优质交通",
  "优良资质",
  "缤纷体验",
] as const;

export const recommendationItemSchema = z.object({
  category: z.enum(RECOMMENDATION_CATEGORIES),
  text: z.string().min(1),
});

const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1),
  recommendations: z.array(recommendationItemSchema).length(3).optional(),
  features: z.string().min(1),
  cover: z
    .object({
      source: z.literal("ctripLibrary").default("ctripLibrary"),
      poi: z.string().min(1),
      description: z.string().min(1),
      minQuality: z.number().min(0).max(5).default(3),
    })
    .optional(),
});

// 自动录入 VBK 基本信息时，除了产品元数据还会用到两类运营数据：
//   - 提前预订：确定性运营规则（默认提前 1 天、12:00 截止），可配置覆盖。
//   - 管家联系人：账号级固定信息，自动化按 stable contactCardId 选择。
// AI 不能生成这两项；product JSON 不写死账号固定信息。地接社名称不属于
// 账号固定信息，由自动化在 VBK 当前页下拉里自动选择第一个可用且非 disabled
// 的选项；缺失时直接报错。
const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const advanceBookingSchema = z.object({
  days: z.number().int().nonnegative(),
  time: z.string().regex(HHMM_REGEX, "时间格式必须为 HH:mm"),
});

const bookingControlsSchema = z.object({
  advanceBooking: advanceBookingSchema.optional(),
  // 管家联系人复用 AccountFixedInfo 的 ContactCardSelection 结构（保持 ID 稳定）。
  // 地接社不再写入产品 JSON；VBK 下拉里选第一个可用且非 disabled 的项。
  butler: z
    .object({
      contactCardId: z.number().int().positive(),
      displayName: z.string().min(1).optional(),
      providerId: z.number().int().positive().optional(),
    })
    .optional(),
});

const operationsSchema = z.object({
  transport: z.enum(["charter", "shared", "none"]).default("charter"),
  pickupCity: z.string().min(1),
  reusePickupForDropoff: z.boolean().default(true),
  hotelSource: z.literal("nonPlatform").default("nonPlatform"),
  hotelTier: z
    .enum(HOTEL_TIER_VALUES)
    .default("当地3钻酒店/-3"),
  mealsIncluded: z.boolean().default(false),
  // 自动化基本信息的运营控件；可缺省，按默认值填入。
  bookingControls: bookingControlsSchema.optional(),
  vehicleResource: z
    .object({
      vehicleId: z.number().int().positive().optional(),
      resourceId: z.number().int().positive().optional(),
      resourceGroupId: z.number().int().positive(),
      resourceGroupName: z.string().min(1),
      resourceGroupMaxItemPrice: z.number().positive().default(1000),
      requestedDailyCost: z.number().positive().optional(),
      matchedDailyCost: z.number().positive().optional(),
      vehicleModel: z.string().min(1).optional(),
      resourceName: z.string().min(1).optional(),
      supplierCode: z.string().min(1).optional(),
      serviceHoursPerDay: z.number().int().min(4).max(24).default(10),
      serviceKilometersPerDay: z.number().int().min(50).max(1000).default(300),
    })
    .optional(),
  hotelResource: z
    .object({
      source: z.enum(["vbk", "nonPlatform"]),
      resourceId: z.number().int().positive().optional(),
      resourceName: z.string().min(1),
      supplierCode: z.string().min(1).optional(),
      roomType: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      hotelTier: z.enum(HOTEL_TIER_VALUES).optional(),
      diamond: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
    })
    .optional(),
});

const commercialSchema = z.object({
  packageName: z.string().min(1),
  pricing: z.object({
    currency: z.literal("CNY").default("CNY"),
    adult: z.number().positive(),
    child: z.number().nonnegative(),
    minimumTravelers: z.number().int().positive(),
    cost: z
      .object({
        adult: z.number().nonnegative(),
        child: z.number().nonnegative(),
        singleSupplement: z.number().nonnegative().default(0),
        childBed: z.number().nonnegative().default(0),
      })
      .optional(),
  }).optional(),
  inventory: z.object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dailyQuota: z.number().int().positive(),
  }).optional(),
  terms: z.object({
    inclusions: z.string().min(1).optional(),
    exclusions: z.string().min(1).optional(),
    bookingNotes: z.string().min(1).optional(),
    refundPolicy: z.string().min(1).optional(),
    cancellationPolicy: z.string().min(1).optional(),
    changePolicy: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  }).optional(),
  release: z.object({
    submitReview: z.boolean().default(true),
    publishAfterApproval: z.boolean().default(true),
    publicPriceCeiling: z.number().positive(),
    publicAuditRetries: z.number().int().min(1).max(10).default(3),
  }).optional(),
});

export const productSchema = z
  .object({
    sales: z.object({
      productType: z.enum(["domesticShort", "domesticLong"]),
      productForm: z.enum([
        "groupTour",
        "semiSelfGuided",
        "privateTour",
        "freeTravel",
      ]),
      splitGroup: z.boolean().default(false),
    }),
    basicInfo: z.object({
      supplierProductName: z.string().min(2).max(400),
      supplierProductCode: z.string().min(1).max(100),
      subtitle: z.string().min(2).max(80),
      days: z.number().int().min(1).max(60),
      nights: z.number().int().min(0).max(59),
      meetingCity: z.string().min(1),
      destinationCity: z.string().min(1),
      province: z.string().min(1),
      operationNotes: z.string().min(1),
    }),
    presentation: presentationSchema.optional(),
    operations: operationsSchema.optional(),
    commercial: commercialSchema.optional(),
    itinerary: z.array(itineraryDaySchema).min(1),
  })
  .superRefine((product, ctx) => {
    if (product.basicInfo.nights > product.basicInfo.days) {
      ctx.addIssue({
        code: "custom",
        path: ["basicInfo", "nights"],
        message: "晚数不能大于天数",
      });
    }
    if (product.itinerary.length !== product.basicInfo.days) {
      ctx.addIssue({
        code: "custom",
        path: ["itinerary"],
        message: "行程条目数必须与行程天数一致",
      });
    }
  });

export function parseProduct(input) {
  return productSchema.parse(input);
}

export type CtripLibraryImageAspect = "landscape" | "any";

export function findBestCtripLibraryImage(
  images: ReadonlyArray<{ quality: string; resolution: string }>,
  minQuality: number,
  aspect: CtripLibraryImageAspect = "landscape",
) {
  let bestIndex = -1;
  let bestQuality = -Infinity;
  images.forEach((image, index) => {
    const qualities = image.quality.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const lowestQuality = qualities.length ? Math.min(...qualities) : -Infinity;
    const dimensions = image.resolution.match(/\d+/g)?.map(Number) || [];
    const [width = 0, height = 0] = dimensions;
    if (lowestQuality < minQuality || width < 1280 || height < 800) return;
    if (aspect === "landscape" && width < height) return;
    if (lowestQuality > bestQuality) {
      bestQuality = lowestQuality;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export const DEFAULT_ADVANCE_BOOKING_DAYS = 1;
export const DEFAULT_ADVANCE_BOOKING_TIME = "12:00";

/**
 * 读取提前预订配置；缺失时回落到默认值 1 天 12:00。源数据为无效值时返回 null，
 * 调用方应将其视为「运营配置错误」并阻断 basic 阶段。
 */
export function resolveAdvanceBooking(product: Record<string, unknown>): { days: number; time: string } | null {
  const operations = product.operations as Record<string, unknown> | undefined;
  const raw = operations?.bookingControls as Record<string, unknown> | undefined;
  const value = raw?.advanceBooking as Record<string, unknown> | undefined;
  const days = value?.days ?? DEFAULT_ADVANCE_BOOKING_DAYS;
  const time = value?.time ?? DEFAULT_ADVANCE_BOOKING_TIME;
  if (!Number.isInteger(days) || days < 0) return null;
  if (typeof time !== "string" || !HHMM_REGEX.test(time)) return null;
  return { days, time };
}

/**
 * 决定重试时是否需要补跑 basic 阶段。最小可靠方案：每次已有 productId
 * 的自动化重试也始终重跑 basic。fillAndSaveBasicInfo 内部走幂等填写并
 * 在保存后做红错校验，若关键字段仍缺失会立刻抛错阻断后续阶段。返回
 * `complete` 的分支用于调用方把「不是首次创建」这件事记到日志。
 */
export function shouldRefillBasicInfo({
  productId,
  basicInfoSaved,
  product,
}: {
  productId?: string;
  basicInfoSaved?: boolean;
  product: Record<string, unknown>;
}): { refill: boolean; reason: "noProductId" | "retry" | "complete" } {
  if (!productId) return { refill: true, reason: "noProductId" };
  if (basicInfoSaved && !basicInfoCompletenessIssues(product).length) {
    return { refill: true, reason: "complete" };
  }
  return { refill: true, reason: "retry" };
}

/**
 * 基本信息完整性检查：基本页关键字段是否齐备。
 * 返回缺失字段标签数组；空数组表示基本信息完整。
 * 地接社与管家联系人不在产品 JSON 里，运行时由账号固定信息或 VBK 下拉负责。
 */
export function basicInfoCompletenessIssues(product: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const basic = product.basicInfo as Record<string, unknown> | undefined;
  if (!basic?.province || typeof basic.province !== "string" || !basic.province.trim()) {
    issues.push("国家景区（省份）");
  }
  if (!resolveAdvanceBooking(product)) issues.push("提前预订");
  return issues;
}

// 第一版允许暂不维护库存与费用包含：有完整数据时自动录入，没有时跳过对应
// VBK 阶段。价格仍用于运营审查，但只有同时存在库存时才写入价格库存页。
export function automationBlockers(product: Record<string, unknown>) {
  const blockers: Array<{ label: string; detail: string }> = [];
  const commercial = product.commercial as Record<string, unknown> | undefined;
  if (!commercial) {
    blockers.push({ label: "套餐与价格", detail: "缺少套餐、价格库存与条款配置，自动录入无法完成。" });
  } else {
    if (!commercial.packageName) blockers.push({ label: "套餐名称", detail: "请补充套餐名称。" });
    if (!commercial.pricing) blockers.push({ label: "价格", detail: "请补充成人价、儿童价与最低成团人数。" });
  }
  const sales = product.sales as Record<string, unknown> | undefined;
  if (sales?.productForm === "privateTour") {
    const operations = product.operations as Record<string, unknown> | undefined;
    const vehicle = operations?.vehicleResource as Record<string, unknown> | undefined;
    if (!vehicle?.resourceGroupId) {
      blockers.push({ label: "用车资源组", detail: "私家团需要在 VBK 核查并填写现有用车资源组 ID。" });
    }
  }
  return blockers;
}

/**
 * 在 VBK 下拉里挑第一个「可用且非 disabled」的选项。返回 index；没有可用
 * 项返回 -1。emptyTexts 表示空态文案（应排除），disableds 与 texts 同长
 * （true 表示该行不可选）。
 */
export function findFirstEnabledOptionIndex(
  texts: ReadonlyArray<string>,
  disableds: ReadonlyArray<boolean>,
  emptyTexts: ReadonlyArray<string> = [],
): number {
  for (let index = 0; index < texts.length; index += 1) {
    if (disableds[index]) continue;
    const text = (texts[index] || "").trim();
    if (!text) continue;
    if (emptyTexts.some((empty) => empty.trim() === text)) continue;
    return index;
  }
  return -1;
}

/**
 * 国家景区省份下拉匹配：去掉「省/市/自治区/特别行政区」等行政区后缀后做
 * 精确匹配，命中后返回 index；否则返回 -1。
 */
export function findProvinceOptionIndex(
  texts: ReadonlyArray<string>,
  province: string,
): number {
  const label = (province || "").trim();
  if (!label) return -1;
  const exact = texts.findIndex((text) => (text || "").trim() === label);
  if (exact >= 0) return exact;
  const normalise = (value: string) => value
    .replace(/\s+/g, "")
    // VBK 远程搜索结果会把所属国家直接拼在行政区后面，例如“山西中国”。
    .replace(/中国$/, "")
    .replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, "");
  const normalised = normalise(label);
  return texts.findIndex((text) => normalise((text || "").trim()) === normalised);
}

/**
 * 管家联系人下拉：优先按 stable contactCardId 匹配（option.value 携带），
 * 失败回退到 displayName 匹配。VBK 下拉会把邮箱和手机号拼到姓名后面，
 * 因此既接受纯姓名，也接受「姓名 + 空白 + 联系方式」；不接受
 * 「姓名-国际」这类同名前缀，避免选错联系人。都失败返回 -1。
 */
export function findButlerOptionIndex(
  options: ReadonlyArray<{ value: string; label: string }>,
  selection: { contactCardId: number; displayName?: string },
): number {
  const byId = options.findIndex((option) => String(option.value) === String(selection.contactCardId));
  if (byId >= 0) return byId;
  if (selection.displayName) {
    const targetName = selection.displayName.trim();
    const byName = options.findIndex((option) => {
      // VBK 实际选项前会带私有区图标字符（例如“󰄼 安思科 ...”），
      // 先剥掉姓名前的非字母数字装饰，再做严格姓名边界匹配。
      const label = (option.label || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[^\p{L}\p{N}]+/u, "");
      return label === targetName || label.startsWith(`${targetName} `);
    });
    if (byName >= 0) return byName;
  }
  return -1;
}

/**
 * 从行程中按确定性规则挑选「重点景点」：先取行程里出现在产品推荐语或
 * 产品特点中的景点，再按行程顺序补足。这样会优先选择产品主打 IP，同时
 * 不调用任何 LLM。括号中的别名也参与匹配，例如「永祚寺（双塔寺）」可由
 * 推荐语中的「永祚寺」命中。
 */
export function pickKeySpotsFromItinerary(
  product: Record<string, unknown>,
  max = 3,
): string[] {
  const limit = Number.isInteger(max) && max > 0 ? max : 3;
  const itinerary = Array.isArray(product.itinerary) ? (product.itinerary as Array<Record<string, unknown>>) : [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const day of itinerary) {
    if (!day || typeof day !== "object") continue;
    const spots = Array.isArray(day.spots) ? (day.spots as Array<unknown>) : [];
    for (const raw of spots) {
      if (typeof raw !== "string") continue;
      const text = raw.trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(text);
    }
  }
  const presentation = product.presentation as Record<string, unknown> | undefined;
  const corpus = [presentation?.recommendation, presentation?.features]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, "");
  const isHighlighted = (spot: string) => {
    const compact = spot.replace(/\s+/g, "");
    const aliases = [
      compact,
      compact.replace(/[（(].*?[）)]/g, ""),
      ...Array.from(compact.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1]),
    ].filter(Boolean);
    return aliases.some((alias) => corpus.includes(alias));
  };
  // 首日第一个景点通常是行程落地后的核心到访点；先保留它，再从产品
  // 推荐语中挑主打景点。当前太原行程因此得到“柳巷、晋祠、山西博物院”。
  const firstItinerarySpot = candidates[0];
  return [
    ...(firstItinerarySpot ? [firstItinerarySpot] : []),
    ...candidates.filter((spot) => spot !== firstItinerarySpot && isHighlighted(spot)),
    ...candidates.filter((spot) => spot !== firstItinerarySpot && !isHighlighted(spot)),
  ].slice(0, limit);
}
