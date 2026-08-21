/**
 * 运营手工复核阶段里把单个字段写入 product JSON 的工具。
 * 仅依赖 shared 契约，不引入 VBK 浏览器，保持纯函数特性便于测试。
 *
 * 支持的字段（用 `field` discriminator 拆分）：
 *  - pricing                  : commercial.pricing.adult / child / minimumTravelers / currency（保留现有 cost）
 *  - inventory                : commercial.inventory.startDate / endDate / dailyQuota
 *  - basicInfoSubtitle        : basicInfo.subtitle
 *  - vehicleResource          : operations.vehicleResource.requestedTotalCost
 *  - itinerarySpotPoi         : itinerary[dayIndex].spots[spotIndex].poiName / poiId
 *  - butlerContact            : operations.bookingControls.butler（写入完整 ContactCardSelection；null 表示清空）
 *  - productCover             : presentation.cover（ctripLibrary / manualUpload 二选一）
 *
 * 写入策略：
 *   - 数值字段：> 0（pricing.adult / requestedTotalCost）；
 *     pricing.child >= 0；pricing.minimumTravelers 必须是正整数；
 *     requestedTotalCost > 0（可独立为 null）；
 *   - 文本字段：trim 后非空，> 1 字符（与 schema subtitle 同步）；
 *   - 真实资源组 ID / 名称只能由 VBK 匹配回填，手动复核入口不写。
 *   - 与 AI 写入路径完全解耦：product 走 schema 校验后才落库。
 *   - productCover：源 manualUpload 时 fileId 必须先经 cover:uploadManual
 *     写入本地副本；该 helper 只校验形状，不验证文件存在——文件存在由
 *     applyCoverField 在 retainManualCoverFile 阶段校验。
 */

import type { ContactCardSelection, ManualReviewFieldInput, ProductCover } from "../../shared/contracts.js";

/**
 * 防御式地把 unknown 转成 object 记录，遇到 null / 非对象 / 数组都返回空对象，
 * 用于后续展开时不需要再做 null 检查。
 */
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 把 input 中的合法字段覆盖到 product，返回新 product，调用方决定是否落库。
 *  - 任何子项校验失败立即抛错，不写一半；
 *  - 不修改原 product 的副本（structuredClone）。
 */
export function applyManualReviewField(product: Record<string, unknown>, input: ManualReviewFieldInput): Record<string, unknown> {
  switch (input.field) {
    case "pricing": return applyPricing(product, input.adult, input.child, input.minimumTravelers);
    case "inventory": return applyInventory(product, input.startDate, input.endDate, input.dailyQuota);
    case "basicInfoSubtitle": return applyBasicInfoSubtitle(product, input.subtitle);
    case "vehicleResource": return applyVehicleResource(product, input);
    case "itinerarySpotPoi": return applyItinerarySpotPoi(product, input);
    case "butlerContact": return applyButlerContact(product, input.selection);
    case "productCover": return applyProductCover(product, input.cover);
    default: {
      // 编译期已穷尽，运行期兜底
      const exhaustive: never = input;
      throw new Error(`不支持的 ManualReviewFieldInput：${(exhaustive as { field?: string }).field ?? "unknown"}`);
    }
  }
}

function applyItinerarySpotPoi(
  product: Record<string, unknown>,
  input: Extract<ManualReviewFieldInput, { field: "itinerarySpotPoi" }>,
): Record<string, unknown> {
  if (!Number.isInteger(input.dayIndex) || input.dayIndex < 0) throw new Error("行程天数索引不合法。");
  if (!Number.isInteger(input.spotIndex) || input.spotIndex < 0) throw new Error("景点索引不合法。");
  const poiName = input.poiName.trim();
  if (!poiName) throw new Error("POI 名称不能为空。");
  if (!Number.isInteger(input.poiId) || input.poiId <= 0) throw new Error("POI ID 必须是正整数。");

  const next = structuredClone(product) as Record<string, unknown>;
  if (!Array.isArray(next.itinerary)) throw new Error("当前产品没有可写入的每日行程。");
  const day = next.itinerary[input.dayIndex];
  if (!day || typeof day !== "object" || Array.isArray(day)) throw new Error("目标行程天数不存在。");

  const dayRecord = day as Record<string, unknown>;
  if (!Array.isArray(dayRecord.spots)) throw new Error("目标行程没有可写入的景点列表。");
  const spot = dayRecord.spots[input.spotIndex];
  if (!spot || typeof spot !== "object" || Array.isArray(spot)) throw new Error("目标景点不存在。");

  dayRecord.spots[input.spotIndex] = {
    ...(spot as Record<string, unknown>),
    poiName,
    poiId: input.poiId,
  };
  return next;
}

function applyPricing(product: Record<string, unknown>, adult: number, child: number, minimumTravelers: number): Record<string, unknown> {
  if (!Number.isFinite(adult) || adult <= 0) throw new Error("成人价必须大于 0。");
  if (!Number.isFinite(child) || child < 0) throw new Error("儿童价不能小于 0。");
  if (!Number.isInteger(minimumTravelers) || minimumTravelers <= 0) throw new Error("起订人数必须是大于 0 的整数。");
  const next = structuredClone(product) as Record<string, unknown>;
  const commercial = objectValue(next.commercial);
  const previousPricing = objectValue(commercial.pricing);
  // 显式保留 cost（成本）子对象：manual 三字段保存不应误删运营此前已经填好
  // 的成本信息；只把三字段（adult / child / minimumTravelers）覆盖写回。
  const nextPricing: Record<string, unknown> = {
    ...previousPricing,
    currency: "CNY",
    adult,
    child,
    minimumTravelers,
  };
  if (!("cost" in previousPricing)) {
    delete nextPricing.cost;
  }
  commercial.pricing = nextPricing;
  next.commercial = commercial;
  return next;
}

function applyInventory(product: Record<string, unknown>, startDate: string, endDate: string, dailyQuota: number): Record<string, unknown> {
  const start = String(startDate ?? "").trim();
  const end = String(endDate ?? "").trim();
  if (!isIsoDate(start)) throw new Error("班期开始日期必须是 YYYY-MM-DD。");
  if (!isIsoDate(end)) throw new Error("班期结束日期必须是 YYYY-MM-DD。");
  if (start > end) throw new Error("班期开始日期不能晚于结束日期。");
  if (!Number.isInteger(dailyQuota) || dailyQuota <= 0) throw new Error("每日配额必须是正整数。");

  const next = structuredClone(product) as Record<string, unknown>;
  const commercial = objectValue(next.commercial);
  commercial.inventory = { startDate: start, endDate: end, dailyQuota };
  next.commercial = commercial;
  return next;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

function applyBasicInfoSubtitle(product: Record<string, unknown>, subtitle: string): Record<string, unknown> {
  const trimmed = (subtitle ?? "").trim();
  // 与 schema 保持一致：subtitle 长度 2..80。
  if (trimmed.length < 2) throw new Error("副标题至少需要 2 个字符。");
  if (trimmed.length > 80) throw new Error("副标题不能超过 80 个字符。");
  const next = structuredClone(product) as Record<string, unknown>;
  const basicInfo = objectValue(next.basicInfo);
  basicInfo.subtitle = trimmed;
  next.basicInfo = basicInfo;
  return next;
}

function applyVehicleResource(
  product: Record<string, unknown>,
  input: Extract<ManualReviewFieldInput, { field: "vehicleResource" }>,
): Record<string, unknown> {
  const next = structuredClone(product) as Record<string, unknown>;
  const operations = objectValue(next.operations);
  const vehicle = { ...objectValue(operations.vehicleResource) };

  // 不存在的子项视为「不动」，null 表示清空 requestedTotalCost。
  if (input.requestedTotalCost !== undefined) {
    if (input.requestedTotalCost === null) {
      // 显式清空「全程预计用车总成本·待核查」：同时写一个 sentinel 字段，让下游
      // targetVehicleTotalCost 能区分「从未设置」与「被用户主动清除」，
      // 避免后续自动匹配继续使用已清空的全程用车总成本。
      delete vehicle.requestedTotalCost;
      delete vehicle.requestedDailyCost;
      vehicle.requestedTotalCostCleared = true;
    } else {
      if (!Number.isFinite(input.requestedTotalCost) || input.requestedTotalCost <= 0) {
        throw new Error("全程预计用车总成本必须大于 0，或传 null 清除。");
      }
      vehicle.requestedTotalCost = input.requestedTotalCost;
      delete vehicle.requestedDailyCost;
      // 重新设值时把上一次的清除标记也撤销，否则旧的「已清除」语义会污染
      // 新一轮的估算路径。
      delete vehicle.requestedTotalCostCleared;
      delete vehicle.requestedDailyCostCleared;
    }
  }

  operations.vehicleResource = vehicle;
  next.operations = operations;
  return next;
}

function applyButlerContact(
  product: Record<string, unknown>,
  selection: ContactCardSelection | null,
): Record<string, unknown> {
  const next = structuredClone(product) as Record<string, unknown>;
  const operations = objectValue(next.operations);
  const bookingControls = objectValue(operations.bookingControls);

  if (selection === null) {
    delete bookingControls.butler;
  } else {
    if (!isContactCardSelection(selection)) {
      throw new Error("管家联系人必须包含合法的 contactCardId / providerId / displayName。");
    }
    bookingControls.butler = {
      contactCardId: selection.contactCardId,
      displayName: selection.displayName.trim(),
      providerId: selection.providerId,
    };
  }

  // 没有任何控件（advanceBooking / butler 都缺）时整个 bookingControls 也删掉，
  // 与其它 schema-optional 字段保持一致，不在 product 里堆积空对象。
  if (Object.keys(bookingControls).length === 0) {
    delete operations.bookingControls;
  } else {
    operations.bookingControls = bookingControls;
  }
  next.operations = operations;
  return next;
}

/**
 * 类型守卫：判断一个对象是否是合法的 ContactCardSelection。
 * - 三个字段都必须存在且类型正确；
 * - id / providerId 必须为正整数，displayName 必须为非空字符串。
 */
function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const id = candidate.contactCardId;
  const providerId = candidate.providerId;
  const name = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  return Number.isInteger(id) && (id as number) > 0
    && Number.isInteger(providerId) && (providerId as number) > 0
    && name.length > 0;
}

/**
 * 把产品封面写入 presentation.cover：
 *  - 接受 ProductCover（ctripLibrary / manualUpload 二选一）；
 *  - ctripLibrary：必填 imageId（正整数）/ imageUrl（非空）/ poi / description /
 *    minQuality；可选 thumbnailUrl / previewUrl / score / resolution /
 *    poiId / poiName / selectedAt，缺省时被剥离不写入，避免后续 UI 误判；
 *  - manualUpload：除上述三项外还需 fileId / originalName / mimeType / sizeBytes /
 *    uploadedAt 全部非空；mime 必须在白名单内（与 cover-storage 同步）；
 *  - 校验失败立即抛错，product 副本不写半成品。
 *
 * 注意：本函数**不**校验 manualUpload 的 fileId 是否在本地副本中存在——
 * 文件存在校验在主进程 IPC 路由里通过 cover:uploadManual + retainManualCoverFile
 * 完成；本函数保持纯函数特性便于测试。
 */
function applyProductCover(
  product: Record<string, unknown>,
  cover: ProductCover,
): Record<string, unknown> {
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) {
    throw new Error("封面写入项必须是合法对象。");
  }
  const poi = typeof cover.poi === "string" ? cover.poi.trim() : "";
  const description = typeof cover.description === "string" ? cover.description.trim() : "";
  const minQuality = typeof cover.minQuality === "number" && Number.isFinite(cover.minQuality)
    ? cover.minQuality
    : null;
  if (!poi) throw new Error("封面 POI 不能为空。");
  if (!description) throw new Error("封面描述不能为空。");
  if (minQuality === null || minQuality < 0 || minQuality > 5) {
    throw new Error("封面最低质量分必须为 0~5 之间的数字。");
  }
  if (cover.source === "ctripLibrary") {
    // imageId / imageUrl 是携程图库封面「一张具体图片」的主键与展示 URL：
    // 缺其中任一字段都视为非法写入，直接抛错（与 shared CtripLibraryCover
    // 契约保持一致），不写半成品 cover。
    const rawImageId = (cover as { imageId?: unknown }).imageId;
    if (!Number.isInteger(rawImageId) || (rawImageId as number) <= 0) {
      throw new Error("携程图库封面缺少合法的 imageId（必须是正整数）。");
    }
    const imageId = rawImageId as number;
    const imageUrlRaw = typeof (cover as { imageUrl?: unknown }).imageUrl === "string"
      ? ((cover as { imageUrl: string }).imageUrl).trim()
      : "";
    if (!imageUrlRaw) {
      throw new Error("携程图库封面缺少 imageUrl。");
    }

    // 可选字段：仅保留「确实存在且合法」的值，避免把 undefined / 空字符串 /
    // 非法数字写入 product JSON 后污染后续 UI 渲染与 schema 二次校验。
    const coverRecord = cover as unknown as Record<string, unknown>;
    const thumbnailUrl = typeof coverRecord.thumbnailUrl === "string" ? coverRecord.thumbnailUrl.trim() : "";
    const previewUrl = typeof coverRecord.previewUrl === "string" ? coverRecord.previewUrl.trim() : "";
    const scoreRaw = coverRecord.score;
    const resolution = typeof coverRecord.resolution === "string" ? coverRecord.resolution.trim() : "";
    const poiIdRaw = coverRecord.poiId;
    const poiName = typeof coverRecord.poiName === "string" ? coverRecord.poiName.trim() : "";
    const selectedAt = typeof coverRecord.selectedAt === "string" ? coverRecord.selectedAt.trim() : "";

    const optionalFields: {
      thumbnailUrl?: string;
      previewUrl?: string;
      score?: number;
      resolution?: string;
      poiId?: number;
      poiName?: string;
      selectedAt?: string;
    } = {};
    if (thumbnailUrl) optionalFields.thumbnailUrl = thumbnailUrl;
    if (previewUrl) optionalFields.previewUrl = previewUrl;
    if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw)) {
      optionalFields.score = scoreRaw;
    }
    if (resolution) optionalFields.resolution = resolution;
    if (typeof poiIdRaw === "number" && Number.isInteger(poiIdRaw) && poiIdRaw > 0) {
      optionalFields.poiId = poiIdRaw;
    }
    if (poiName) optionalFields.poiName = poiName;
    if (selectedAt) optionalFields.selectedAt = selectedAt;

    const next = structuredClone(product) as Record<string, unknown>;
    const presentation = objectValue(next.presentation);
    presentation.cover = {
      source: "ctripLibrary",
      imageId,
      imageUrl: imageUrlRaw,
      poi,
      description,
      minQuality,
      ...optionalFields,
    } satisfies ProductCover;
    next.presentation = presentation;
    return next;
  }
  if (cover.source === "manualUpload") {
    const fileId = typeof cover.fileId === "string" ? cover.fileId.trim() : "";
    const originalName = typeof cover.originalName === "string" ? cover.originalName.trim() : "";
    const mimeType = cover.mimeType;
    const sizeBytes = cover.sizeBytes;
    const uploadedAt = typeof cover.uploadedAt === "string" ? cover.uploadedAt.trim() : "";
    const allowedMimes = ["image/jpeg", "image/png", "image/webp"] as const;
    if (!fileId) throw new Error("手动上传封面缺少 fileId。");
    if (!originalName) throw new Error("手动上传封面缺少文件名。");
    if (!allowedMimes.includes(mimeType as (typeof allowedMimes)[number])) {
      throw new Error(`手动上传封面 mime 必须是 ${allowedMimes.join("、")} 之一。`);
    }
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error("手动上传封面 sizeBytes 必须是正整数。");
    }
    if (!uploadedAt) throw new Error("手动上传封面缺少 uploadedAt。");
    const next = structuredClone(product) as Record<string, unknown>;
    const presentation = objectValue(next.presentation);
    presentation.cover = {
      source: "manualUpload",
      fileId,
      originalName,
      mimeType,
      sizeBytes,
      poi,
      description,
      minQuality,
      uploadedAt,
    } satisfies ProductCover;
    next.presentation = presentation;
    return next;
  }
  throw new Error(`封面来源必须是 ctripLibrary 或 manualUpload，当前：${String((cover as { source?: unknown }).source)}`);
}
