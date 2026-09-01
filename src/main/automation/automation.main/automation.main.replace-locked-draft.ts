import type { ProductDetail } from "../../../shared/contracts.js";

/**
 * 平台一旦创建产品壳，产品类型便不可编辑。对于尚未提审且已经失败的旧版
 * domesticLong 草稿，保留原远端 ID 作为审计记录，清空本地绑定后由正常
 * 自动录入链创建一个 domesticShort 替代草稿；绝不删除或提交旧草稿。
 */
export function prepareLockedDraftReplacement(product: ProductDetail): {
  previousProductId: string;
  replacementProduct: Record<string, unknown>;
} {
  const previousProductId = String(product.productId ?? "").trim();
  if (!previousProductId) throw new Error("当前产品没有可替代的远端草稿。");
  if (product.status !== "blocked" || product.automation?.status !== "failed") {
    throw new Error("仅允许替代尚未完成且已失败的旧草稿。");
  }
  const sales = product.product.sales;
  if (!sales || typeof sales !== "object" || Array.isArray(sales)
    || (sales as Record<string, unknown>).productType !== "domesticLong") {
    throw new Error("当前草稿不属于可安全替代的旧版境内长线产品。");
  }
  return {
    previousProductId,
    replacementProduct: {
      ...product.product,
      sales: { ...(sales as Record<string, unknown>), productType: "domesticShort" },
    },
  };
}

/** 替代前必须再次以 VBK 为准确认旧草稿尚未提审、未激活、未发布。 */
export function assertRemoteDraftCanBeReplaced(raw: unknown): void {
  const root = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  const sale = data.saleControlInfo as Record<string, unknown> | undefined;
  const base = data.baseInfo as Record<string, unknown> | undefined;
  const meta = data.meta as Record<string, unknown> | undefined;
  if (Number(sale?.productCategoryID ?? sale?.productCategoryId) !== 10
    || String(base?.active) !== "F"
    || String(meta?.auditStatus) !== "N"
    || String(meta?.releaseActive) !== "F") {
    throw new Error("VBK 远端草稿已不满足安全替代条件，不会创建替代产品。");
  }
}
