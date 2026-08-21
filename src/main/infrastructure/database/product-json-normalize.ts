/**
 * 历史 product_json 兼容迁移。
 *
 * 早期版本（V0.x）生成的 product_json 字段集与现行 schema 略有差异：
 *   - 没有 `sales` / `operations` / `itinerary` 段；
 *   - `basicInfo.meetingCity` 可能缺失（用 destinationCity 兜底）；
 *   - `logs` / `messages` / `researchTasks` 产品字段不存在（默认为 undefined）。
 *
 * 这份模块只做"读到内存时"的归一化，**不**回写数据库，也不强行把整张
 * 库的 product_json 一次性升级；写到数据库时由 ai / 产品 UI 自行决定
 * 是否用 patch 触发一次 updateProduct 持久化。
 *
 * 归一化原则：
 *   - 任何字段缺失都用 DEFAULT_PRODUCT 兜底，保证前端拿到的是 minimum
 *     valid product 形态；
 *   - 字符串字段强转并 trim，map/list 字段缺失返回空 map/list；
 *   - 不抛错。解析失败时返回兜底，避免某个脏 row 让整个 getProduct 失效。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import { defaultCommercialInventory } from "../../data/commercial-defaults.js";

/**
 * 最小可渲染 product 兜底：必须满足 schema 验证（看 schema-functions.ts 的
 * DEFAULT_PRODUCT），并保证新建产品也能通过 parseProduct 校验。
 */
const DEFAULT_PRODUCT = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
  basicInfo: {
    supplierProductName: "",
    supplierProductCode: "",
    days: 0,
    nights: 0,
    meetingCity: "",
    destinationCity: "",
  },
  operations: { hotelSource: "nonPlatform", hotelTier: "threeStar", mealsIncluded: false, vehicleResource: {} },
  itinerary: [],
  ...overrides,
});

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

function normaliseItineraryPois(value: unknown) {
  if (!Array.isArray(value)) return value;
  return value.map((day) => {
    if (!day || typeof day !== "object" || Array.isArray(day)) return day;
    const record = day as Record<string, unknown>;
    if (!Array.isArray(record.spots)) return day;
    record.spots = record.spots.map((spot) => {
      if (typeof spot === "string") return { name: spot.trim(), poiName: null, poiId: null };
      if (!spot || typeof spot !== "object" || Array.isArray(spot)) return spot;
      const candidate = spot as Record<string, unknown>;
      return { ...candidate, poiId: normalisePoiId(candidate.poiId) };
    });
    return record;
  });
}

function normaliseVehicleResource(value: unknown, days: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const vehicle = value as Record<string, unknown>;
  const requestedTotalCost = positiveNumberValue(vehicle.requestedTotalCost)
    || (positiveNumberValue(vehicle.requestedDailyCost)
      ? positiveNumberValue(vehicle.requestedDailyCost)! * days
      : undefined);
  return {
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

function normaliseCommercialInventory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const start = typeof record.startDate === "string" ? record.startDate : "";
  const end = typeof record.endDate === "string" ? record.endDate : "";
  const quota = positiveIntegerValue(record.dailyQuota);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !quota) return undefined;
  if (new Date(start) > new Date(end)) return undefined;
  return { startDate: start, endDate: end, dailyQuota: quota };
}

/**
 * 把数据库里的 product_json 字符串解析为统一形态。
 *  - 解析失败 → 兜底；
 *  - 任何字段缺失 → 局部兜底；
 *  - 返回类型是 ProductDetail["product"]，但运行时倾向于 Record<string, unknown>。
 */
export function parseAndNormalizeProductJson(raw: string | null | undefined): ProductDetail["product"] {
  if (!raw) return DEFAULT_PRODUCT() as ProductDetail["product"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PRODUCT() as ProductDetail["product"];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_PRODUCT() as ProductDetail["product"];
  }
  const parsedRecord = parsed as Record<string, unknown>;
  // 2026-08 产品数据结构迁移期间，车辆资源回填曾把整个
  // ProductDetail 误写进 product_json。读取时解开这一层，并保留当时
  // 写在外层的 operations，避免已有草稿在界面里表现成空产品。
  const nestedProduct = parsedRecord.product;
  const product = nestedProduct && typeof nestedProduct === "object" && !Array.isArray(nestedProduct)
    ? {
        ...(nestedProduct as Record<string, unknown>),
        ...(parsedRecord.operations && typeof parsedRecord.operations === "object" && !Array.isArray(parsedRecord.operations)
          ? { operations: parsedRecord.operations }
          : {}),
      }
    : parsedRecord;
  const base = DEFAULT_PRODUCT();
  // 复写：保留 DB 已有字段，只对缺失字段补兜底。
  for (const [key, value] of Object.entries(base)) {
    if (product[key] === undefined) product[key] = value;
  }
  // 旧字段兼容：basicInfo.meetingCity 缺失时用 destinationCity 兜底。
  const basicInfo = product.basicInfo as Record<string, unknown> | undefined;
  if (basicInfo && typeof basicInfo === "object") {
    if (!basicInfo.meetingCity && basicInfo.destinationCity) {
      basicInfo.meetingCity = basicInfo.destinationCity;
    }
  }
  const operations = product.operations as Record<string, unknown> | undefined;
  if (operations && typeof operations === "object" && !Array.isArray(operations)) {
    operations.vehicleResource = normaliseVehicleResource(
      operations.vehicleResource,
      positiveIntegerValue(basicInfo?.days) || 1,
    );
  }
  const commercial = product.commercial as Record<string, unknown> | undefined;
  if (commercial && typeof commercial === "object" && !Array.isArray(commercial)) {
    commercial.inventory = normaliseCommercialInventory(commercial.inventory) ?? defaultCommercialInventory();
  }
  product.itinerary = normaliseItineraryPois(product.itinerary);
  return product as ProductDetail["product"];
}
