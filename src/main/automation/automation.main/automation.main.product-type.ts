/**
 * 旧版按天数把 6 天及以上产品标成 domesticLong，但当前产品模型没有
 * 机票 / 火车 / 轮船等大交通卡片。仅在远端产品尚未创建时，把这种旧快照
 * 归一为可承载一地地接行程的 domesticShort，避免重试再次创建必然校验失败
 * 的产品壳。已有远端产品绝不在这里静默改型。
 */
export function normalizeUnsupportedProductTypeBeforeShell(
  product: Record<string, unknown>,
  remoteProductId?: string | null,
): { product: Record<string, unknown>; changed: boolean } {
  if (remoteProductId) return { product, changed: false };

  const sales = product.sales;
  if (!sales || typeof sales !== "object" || Array.isArray(sales)) {
    return { product, changed: false };
  }
  const salesRecord = sales as Record<string, unknown>;
  if (salesRecord.productType !== "domesticLong") {
    return { product, changed: false };
  }

  return {
    product: {
      ...product,
      sales: {
        ...salesRecord,
        productType: "domesticShort",
      },
    },
    changed: true,
  };
}
