/**
 * OrchestratorRuntime 写入前的对象级 merge helpers：
 *   - readValidProductButler：从 product.operations.bookingControls.butler 读
 *     有效的管家联系方式；要求 contactCardId / providerId 都是正整数，displayName 非空；
 *   - mergeBasicInfo：basicInfo 是 shared object，写入时合并现有字段（避免覆盖
 *     days / cities / 但ler 等关键字段）；privateTour 自动追加副标题；
 *   - mergePresentation：presentation.features 必须是非空 HTML；
 *   - mergeSkeletonOperations：skeleton（operations）走 mergeSkeletonOperations；
 *   - alignProvinceLevelBasicCities：skeleton 写入后，把省级 destinationCity
 *     同步到 pickupCity（避免省份被当成 destination）。
 *
 * 这些都被 DbOrchestratorRuntime.writeModule 在写入产品前调用。
 */

import type { ContactCardSelection, ProductDetail } from "../../../shared/contracts.js";
import type { PlanningModule } from "../../../shared/contracts-planning.js";
import { coerceProductFeaturesHtml } from "../../domain/product/features-rich-text.js";
import { mergeSkeletonOperations } from "../skeleton-operation-merge.js";
import { privateTourSubtitle } from "../../../shared/private-tour-copy.js";
import { isProvinceLevelName } from "./province-scope.js";

export function readValidProductButler(product: Record<string, unknown>): ContactCardSelection | null {
  const operations = product.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return null;
  const bookingControls = (operations as Record<string, unknown>).bookingControls;
  if (!bookingControls || typeof bookingControls !== "object" || Array.isArray(bookingControls)) return null;
  const butler = (bookingControls as Record<string, unknown>).butler;
  if (!butler || typeof butler !== "object" || Array.isArray(butler)) return null;
  const candidate = butler as Record<string, unknown>;
  const id = candidate.contactCardId;
  const providerId = candidate.providerId;
  const displayName = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  if (!Number.isInteger(id) || (id as number) <= 0) return null;
  if (!Number.isInteger(providerId) || (providerId as number) <= 0) return null;
  if (!displayName) return null;
  return { contactCardId: id as number, displayName, providerId: providerId as number };
}

export function mergeBasicInfo(product: ProductDetail, value: unknown): { mergedValue: unknown; rejectReason?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mergedValue: value };
  const existing = product.product.basicInfo && typeof product.product.basicInfo === "object" && !Array.isArray(product.product.basicInfo)
    ? product.product.basicInfo as Record<string, unknown>
    : {};
  const incoming = { ...(value as Record<string, unknown>) };
  if ((product.product.sales as { productForm?: unknown } | undefined)?.productForm === "privateTour" && typeof incoming.subtitle === "string") {
    incoming.subtitle = privateTourSubtitle(incoming.subtitle);
  }
  if (typeof incoming.province === "string") incoming.province = normaliseProvinceNameLocal(incoming.province);
  return { mergedValue: { ...existing, ...incoming } };
}

export function mergePresentation(product: ProductDetail, value: unknown): { mergedValue: unknown; rejectReason?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mergedValue: value };
  const existing = product.product.presentation && typeof product.product.presentation === "object" && !Array.isArray(product.product.presentation)
    ? product.product.presentation as Record<string, unknown>
    : {};
  const incoming = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(incoming, "features")) {
    const features = coerceProductFeaturesHtml(incoming.features);
    if (!features) return { mergedValue: value, rejectReason: "presentation.features 必须是非空 HTML 字符串，不能是对象/数组。" };
    incoming.features = features;
  }
  return { mergedValue: { ...existing, ...incoming } };
}

export function mergeSkeletonOperationsLocal(product: ProductDetail, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const existing = product.product.operations && typeof product.product.operations === "object"
    && !Array.isArray(product.product.operations)
    ? product.product.operations as Record<string, unknown>
    : {};
  return mergeSkeletonOperations(existing, value as Record<string, unknown>);
}

export function alignProvinceLevelBasicCities(
  productData: Record<string, unknown>,
  module: PlanningModule,
  previousProduct: Record<string, unknown>,
): void {
  if (module !== "skeleton") return;
  const basicInfo = productData.basicInfo;
  const operations = productData.operations;
  if (!basicInfo || typeof basicInfo !== "object" || Array.isArray(basicInfo)) return;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return;
  const basic = basicInfo as Record<string, unknown>;
  const ops = operations as Record<string, unknown>;
  const pickupCity = typeof ops.pickupCity === "string" ? ops.pickupCity.trim() : "";
  if (!pickupCity) return;
  const previousBasic = previousProduct.basicInfo;
  const previous = previousBasic && typeof previousBasic === "object" && !Array.isArray(previousBasic)
    ? previousBasic as Record<string, unknown>
    : {};
  const meetingCity = typeof previous.meetingCity === "string" ? previous.meetingCity.trim() : "";
  const destinationCity = typeof previous.destinationCity === "string" ? previous.destinationCity.trim() : "";
  if (isProvinceLevelName(meetingCity)) basic.meetingCity = pickupCity;
  if (isProvinceLevelName(destinationCity)) basic.destinationCity = pickupCity;
}

function normaliseProvinceNameLocal(value: string): string {
  return value.trim().replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, "").trim();
}