/**
 * 产品 JSON 的统一写入口。
 *
 * AI patch 必须在提交瞬间读取数据库最新快照后再应用，不能使用网络请求开始时
 * 的旧对象整包覆盖；所有写入完成后再从数据库读取 ProductDetail 并按需广播。
 */

import type { AiResponse, ProductDetail, ProductSummary } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { applyProductPatchSafe } from "../operations/product-patch.js";
import { normaliseProductLocationFields, toPlatformShortLocationName } from "../../shared/location-short-name.js";

type ProductMutationStore = Pick<VbkDatabase, "getProduct" | "updateProduct">;

export interface ProductMutationOptions {
  status?: ProductSummary["status"];
  notify?: boolean;
}

export class ProductMutationService {
  constructor(
    private readonly store: ProductMutationStore,
    private readonly onUpdated?: (product: ProductDetail) => void,
  ) {}

  replace(
    localProductId: string,
    product: Record<string, unknown>,
    options: ProductMutationOptions = {},
  ): ProductDetail {
    const current = this.store.getProduct(localProductId);
    if (!current) throw productNotFound(localProductId);
    const currentBasic = current.product.basicInfo && typeof current.product.basicInfo === "object"
      && !Array.isArray(current.product.basicInfo)
      ? current.product.basicInfo as Record<string, unknown>
      : {};
    const lockedMeetingCity = toPlatformShortLocationName(
      typeof currentBasic.meetingCity === "string" && currentBasic.meetingCity.trim()
        ? currentBasic.meetingCity
        : currentBasic.destinationCity,
    );
    const normalised = normaliseProductLocationFields(product, lockedMeetingCity || undefined);
    this.store.updateProduct(localProductId, normalised, options.status);
    const saved = this.store.getProduct(localProductId);
    if (!saved) throw productNotFound(localProductId);
    if (options.notify !== false) this.onUpdated?.(saved);
    return saved;
  }

  applyAiPatch(
    localProductId: string,
    patch: NonNullable<AiResponse["patch"]>,
    options: ProductMutationOptions = {},
  ): { product: ProductDetail; applied: boolean } {
    const current = this.store.getProduct(localProductId);
    if (!current) throw productNotFound(localProductId);
    const result = applyProductPatchSafe(current.product, patch);
    if (!result.applied) return { product: current, applied: false };
    return {
      product: this.replace(localProductId, result.product, options),
      applied: true,
    };
  }
}
