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

import type { ContactCardSelection } from "../../../../shared/contracts-types.js";

/** 把 product 树上的基础信息字段安全读出来；缺失项显式返回 null。 */
export interface BasicInfoSnapshot {
  productForm: "privateTour" | "groupTour" | null;
  subtitle: string | null;
  butler: ContactCardSelection | null;
  adult: number | null;
  child: number | null;
  currency: string | null;
  vehicleResource: {
    exists: boolean;
    resourceGroupId: number | null;
    resourceGroupName: string | null;
    requestedDailyCost: number | null;
  };
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
  return {
    productForm: asProductForm(sales.productForm),
    subtitle: asTrimmedString(basic.subtitle),
    butler: asContactCard(bookingControls.butler),
    adult: asNumber(pricing.adult),
    child: asNumber(pricing.child),
    currency: asTrimmedString(pricing.currency),
    vehicleResource: {
      exists: vehicleExists,
      resourceGroupId: asNumber(vehicle.resourceGroupId),
      resourceGroupName: asTrimmedString(vehicle.resourceGroupName),
      requestedDailyCost: asNumber(vehicle.requestedDailyCost),
    },
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

/** 解析价格草稿；非法输入返回 null，UI 据此禁用「保存」按钮。 */
export function parsePricingDraft(adultRaw: string, childRaw: string): { adult: number; child: number } | null {
  const adult = Number(adultRaw);
  const child = Number(childRaw);
  if (!Number.isFinite(adult) || adult <= 0) return null;
  if (!Number.isFinite(child) || child < 0) return null;
  return { adult, child };
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
