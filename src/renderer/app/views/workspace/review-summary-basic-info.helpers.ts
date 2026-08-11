/**
 * 右侧 review 面板「基础信息」模块的纯数据抽取 / 草稿解析工具。
 *
 * 与 React 组件分离（不放 .tsx 里），方便用 `tsx --test` 单测覆盖：
 *  - readBasicInfoFromProduct：把 product 树上的基础信息字段安全读出来；
 *  - parsePricingDraft：UI 草稿 → 主进程可用数值；
 *  - parseRequestedDailyCostDraft：UI 草稿 → 主进程可用数值或清除信号。
 *
 * 写入主路径的合法性由 src/main/operations/manual-review-field.test.ts 覆盖。
 */

import type {
  ContactCardSelection,
  ManualUploadCoverMeta,
  ProductCover,
} from "../../../../shared/contracts-types.js";

/** 把 product 树上的基础信息字段安全读出来；缺失项显式返回 null。 */
export interface BasicInfoSnapshot {
  productForm: "privateTour" | "groupTour" | null;
  subtitle: string | null;
  butler: ContactCardSelection | null;
  adult: number | null;
  child: number | null;
  /**
   * 起订人数：来自 product.commercial.pricing.minimumTravelers。
   *  - 必须为正整数（schema 限定）；
   *  - 缺失 / 非法值返回 null，UI 据此走「待设置」空状态；**绝不**默认填 1，
   *    否则会污染 readiness 与发布校验。
   */
  minimumTravelers: number | null;
  currency: string | null;
  vehicleResource: {
    exists: boolean;
    resourceGroupId: number | null;
    resourceGroupName: string | null;
    requestedDailyCost: number | null;
  };
  /**
   * product.presentation.cover 的安全读取结果：返回 shared `ProductCover`
   * discriminated union，使 UI 调用方可以直接消费，无需再做形状转换。
   *  - source === "ctripLibrary"：poi / description / minQuality 必填；
   *  - source === "manualUpload"：fileId / originalName / mimeType / sizeBytes /
   *    uploadedAt 也必须齐全，缺失则整体返回 null（视为未设置）。
   */
  cover: ProductCover | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function asContactCard(value: unknown): ContactCardSelection | null {
  const obj = asObject(value);
  const id = asNumber(obj.contactCardId);
  const providerId = asNumber(obj.providerId);
  const name = asTrimmedString(obj.displayName);
  if (id === null || providerId === null || !name) return null;
  return { contactCardId: id, providerId, displayName: name };
}

function asProductForm(value: unknown): "privateTour" | "groupTour" | null {
  return value === "privateTour" || value === "groupTour" ? value : null;
}

/**
 * 安全读 product.presentation.cover；缺失 / 非法均返回 null。
 *  - 形状与 cover-storage 的 readCover 类似，但独立实现以避免 renderer 反向
 *    依赖 main 进程模块；
 *  - 直接构造 shared `ProductCover` discriminated union：ctripLibrary / manualUpload
 *    分支各按对应接口的"必填"要求校验，避免 UI 端再做形状转换；
 *  - ctripLibrary 必须同时具备 imageId（正整数）/ imageUrl（非空字符串），
 *    缺任一即视为未设置；可选字段（thumbnailUrl / previewUrl / score /
 *    resolution / poiId / poiName / selectedAt）缺省时整体返回时不写入，
 *    避免渲染层把 undefined 当成"占位"。
 */
function asMimeType(value: unknown): ManualUploadCoverMeta["mimeType"] | null {
  const trimmed = asTrimmedString(value);
  if (trimmed === "image/jpeg" || trimmed === "image/png" || trimmed === "image/webp") {
    return trimmed;
  }
  return null;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * 起订人数必须为正整数；缺失 / 0 / 负数 / 小数返回 null，UI 走空状态。
 * 与 applyManualReviewField / applyPricing 对起订人数的约束保持一致。
 */
export function asPositiveMinimumTravelers(value: unknown): number | null {
  return asPositiveInteger(value);
}

function asProductCover(value: unknown): ProductCover | null {
  if (!isObject(value)) return null;
  const source = value.source;
  if (source !== "ctripLibrary" && source !== "manualUpload") return null;
  const poi = asTrimmedString(value.poi) ?? "";
  const description = asTrimmedString(value.description) ?? "";
  const minQuality = asNumber(value.minQuality) ?? 3;
  if (!poi || !description) return null;
  if (source === "manualUpload") {
    const fileId = asTrimmedString(value.fileId);
    const originalName = asTrimmedString(value.originalName);
    const mimeType = asMimeType(value.mimeType);
    const sizeBytes = asNumber(value.sizeBytes);
    const uploadedAt = asTrimmedString(value.uploadedAt);
    if (!fileId || !originalName || !mimeType || sizeBytes === null || !uploadedAt) {
      return null;
    }
    return {
      source: "manualUpload",
      fileId,
      originalName,
      mimeType,
      sizeBytes,
      poi,
      description,
      minQuality,
      uploadedAt,
    };
  }
  // ctripLibrary：imageId / imageUrl 是必填，缺任一即视为未设置。
  const imageId = asPositiveInteger(value.imageId);
  const imageUrl = asTrimmedString(value.imageUrl);
  if (imageId === null || !imageUrl) return null;

  // 可选字段：仅保留合法值，缺省时不写入（与 main 端 applyProductCover
  // 对称），保证写入 -> object 读回对象的 shape 严格匹配 schema。
  const optionalFields: {
    thumbnailUrl?: string;
    previewUrl?: string;
    score?: number;
    resolution?: string;
    poiId?: number;
    poiName?: string;
    selectedAt?: string;
  } = {};
  const thumbnailUrl = asTrimmedString(value.thumbnailUrl);
  if (thumbnailUrl) optionalFields.thumbnailUrl = thumbnailUrl;
  const previewUrl = asTrimmedString(value.previewUrl);
  if (previewUrl) optionalFields.previewUrl = previewUrl;
  const scoreRaw = value.score;
  if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw)) {
    optionalFields.score = scoreRaw;
  }
  const resolution = asTrimmedString(value.resolution);
  if (resolution) optionalFields.resolution = resolution;
  const poiId = asPositiveInteger(value.poiId);
  if (poiId !== null) optionalFields.poiId = poiId;
  const poiName = asTrimmedString(value.poiName);
  if (poiName) optionalFields.poiName = poiName;
  const selectedAt = asTrimmedString(value.selectedAt);
  if (selectedAt) optionalFields.selectedAt = selectedAt;

  return {
    source: "ctripLibrary",
    imageId,
    imageUrl,
    poi,
    description,
    minQuality,
    ...optionalFields,
  };
}

export function readBasicInfoFromProduct(product: unknown): BasicInfoSnapshot {
  const root = asObject(product);
  const sales = asObject(root.sales);
  const basic = asObject(root.basicInfo);
  const commercial = asObject(root.commercial);
  const pricing = asObject(commercial.pricing);
  const operations = asObject(root.operations);
  const vehicleExists = isObject(operations.vehicleResource);
  const vehicle = asObject(operations.vehicleResource);
  const bookingControls = asObject(operations.bookingControls);
  const presentation = asObject(root.presentation);
  return {
    productForm: asProductForm(sales.productForm),
    subtitle: asTrimmedString(basic.subtitle),
    butler: asContactCard(bookingControls.butler),
    adult: asNumber(pricing.adult),
    child: asNumber(pricing.child),
    minimumTravelers: asPositiveInteger(pricing.minimumTravelers),
    currency: asTrimmedString(pricing.currency),
    vehicleResource: {
      exists: vehicleExists,
      resourceGroupId: asNumber(vehicle.resourceGroupId),
      resourceGroupName: asTrimmedString(vehicle.resourceGroupName),
      requestedDailyCost: asNumber(vehicle.requestedDailyCost),
    },
    cover: asProductCover(presentation.cover),
  };
}

export function shouldShowVehicleResourceRow(snapshot: BasicInfoSnapshot): boolean {
  const vehicle = snapshot.vehicleResource;
  const hasVehicleData = vehicle.resourceGroupId !== null
    || vehicle.resourceGroupName !== null
    || vehicle.requestedDailyCost !== null;
  return snapshot.productForm === "privateTour"
    || hasVehicleData;
}

/** 解析价格草稿；非法输入返回 null，UI 据此禁用「保存」按钮。
 *  - 成人 > 0；
 *  - 儿童 ≥ 0；
 *  - 起订人数必须是正整数；空串 / 0 / 负数 / 小数都视为非法。
 *  - 任一字段缺失即视为待补充，返回 null；起订人数**绝不**默认填值。
 */
export function parsePricingDraft(
  adultRaw: string,
  childRaw: string,
  minimumTravelersRaw: string,
): { adult: number; child: number; minimumTravelers: number } | null {
  const adult = Number(adultRaw);
  const child = Number(childRaw);
  const minimumTravelers = Number(minimumTravelersRaw);
  if (!Number.isFinite(adult) || adult <= 0) return null;
  if (!Number.isFinite(child) || child < 0) return null;
  if (!Number.isFinite(minimumTravelers)) return null;
  if (!Number.isInteger(minimumTravelers) || minimumTravelers <= 0) return null;
  return { adult, child, minimumTravelers };
}

/** 解析 AI 预估日价草稿：
 *  - 合法正数 → 返回 number，UI 直接写入；
 *  - 空 / 0 / 负数 / 非数 → 返回 "invalid"，UI 禁用「保存」按钮；
 *  - 注：本 helper 永不返回 null；清除动作由 UI 显式发 null 给主进程。 */
export function parseRequestedDailyCostDraft(raw: string): number | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return "invalid";
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return "invalid";
  return value;
}
