import type { ProductDetail } from "../../shared/contracts.js";
import type { VbkDatabase } from "./database/database.js";
import type { AppAuthStore } from "./app-auth-store.js";
import { TibetProductConflictError, type TibetProductService } from "./tibet-products.js";

/** Local authority with a read-only bridge for historical cloud products.
 * Local mutations are saved first; the storage boundary replicates them to Tibet.
 */
export function createLocalProductService(args: {
  db: VbkDatabase; store: AppAuthStore;
  capture(product: ProductDetail): void;
}): TibetProductService {
  const owner = () => {
    const id = args.store.get()?.user.id;
    if (!id) throw new Error("请先登录应用账号后再操作产品。");
    return id;
  };
  const owned = (id: string, userId: number): ProductDetail => {
    const state = args.db.readLocalProductState(id);
    const product = args.db.getProduct(id);
    if (!product || state?.ownerUserId !== userId) throw new Error("产品不存在，请刷新后重试。");
    return product;
  };
  return {
    storage: "local",
    async list() {
      const userId = owner();
      const products = args.db.listOwnedLocalProductSummaries(userId);
      if (owner() !== userId) throw new Error("账号已切换，请刷新产品列表。");
      return products;
    },
    async get(id) {
      const userId = owner();
      if (owner() !== userId) throw new Error("账号已切换，请刷新产品。");
      return owned(id, userId);
    },
    async upsert(product) {
      const userId = owner();
      const state = args.db.readLocalProductState(product.id);
      if (state) return owned(product.id, userId);
      if (args.db.getProduct(product.id)) throw new Error("已有本地产品需先确认归属，不能覆盖。");
      const saved = args.db.saveLocalProductState(product, userId, 1);
      args.capture(saved);
      return saved;
    },
    async update(product, expectedRevision) {
      const userId = owner();
      const latest = owned(product.id, userId);
      if (expectedRevision !== latest.revision || product.productJsonVersion === undefined
        || product.productJsonVersion !== latest.productJsonVersion) throw new TibetProductConflictError(latest);
      const saved = args.db.saveLocalProductState({ ...product, updatedAt: new Date().toISOString() }, userId, expectedRevision + 1);
      args.capture(saved);
      return saved;
    },
    async delete(id) {
      owned(id, owner());
      if (!args.db.deleteProduct(id)) throw new Error("产品不存在。");
    },
  };
}
