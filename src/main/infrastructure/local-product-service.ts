import type { ProductDetail } from "../../shared/contracts.js";
import { logWarn } from "../../shared/log-timestamp.js";
import type { VbkDatabase } from "./database/database.js";
import type { AppAuthStore } from "./app-auth-store.js";
import { TibetProductConflictError, type TibetProductService } from "./tibet-products.js";

/** Local authority with a read-only bridge for historical cloud products.
 * No product mutation is sent to Tibet. Diagnostics are queued separately.
 */
export function createLocalProductService(args: {
  db: VbkDatabase; store: AppAuthStore;
  legacy?: Pick<TibetProductService, "list" | "get">;
  capture(product: ProductDetail): void;
}): TibetProductService {
  const bootstraps = new Map<number, Promise<void>>();
  const attempts = new Map<number, number>();
  const owner = () => {
    const id = args.store.get()?.user.id;
    if (!id) throw new Error("请先登录应用账号后再操作产品。");
    return id;
  };
  const bootstrap = async (userId: number) => {
    const key = `localProductsMigrated:${userId}`;
    if (!args.legacy || args.db.getSetting(key)?.value === "1") return;
    if (bootstraps.has(userId)) return bootstraps.get(userId);
    if (Date.now() - (attempts.get(userId) ?? 0) < 60_000) return;
    attempts.set(userId, Date.now());
    const work = (async () => {
      const summaries = await args.legacy!.list();
      for (const summary of summaries) {
        if (owner() !== userId) return;
        const state = args.db.readLocalProductState(summary.id);
        if (state) continue;
        const remote = await args.legacy!.get(summary.id);
        if (owner() !== userId) return;
        const local = args.db.getProduct(summary.id);
        // Existing local business/automation is never replaced during migration.
        const snapshot = { ...remote, ...local,
          planning: local?.planning ?? remote.planning, aiUsage: local?.aiUsage ?? remote.aiUsage,
          vbkAccount: remote.vbkAccount,
        };
        if (local) args.db.attachLocalProductState(snapshot, userId, 1);
        else args.db.saveLocalProductState(snapshot, userId, 1);
      }
      if (owner() === userId) args.db.setSetting(key, "1");
    })().catch(() => {
      logWarn("[local-products] historical cloud import deferred");
    }).finally(() => { bootstraps.delete(userId); });
    bootstraps.set(userId, work);
    await work;
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
      let products = args.db.listOwnedLocalProductSummaries(userId);
      if (products.length) void bootstrap(userId);
      else {
        await bootstrap(userId);
        products = args.db.listOwnedLocalProductSummaries(userId);
      }
      if (owner() !== userId) throw new Error("账号已切换，请刷新产品列表。");
      return products;
    },
    async get(id) {
      const userId = owner();
      if (!args.db.readLocalProductState(id)) await bootstrap(userId);
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
      if (expectedRevision !== latest.revision || (product.productJsonVersion !== undefined
        && product.productJsonVersion !== latest.productJsonVersion)) throw new TibetProductConflictError(latest);
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
