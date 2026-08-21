import { logWarn } from "../../shared/log-timestamp.js";
import type { ProductDetail } from "../../shared/contracts.js";
import { TibetProductConflictError, type TibetProductService } from "../infrastructure/tibet-products.js";

/**
 * Serialises legacy local mutations into Tibet. SQLite remains an operational
 * cache for automation code, while every user-visible snapshot is broadcast
 * only after the remote revisioned PATCH succeeds.
 */
export function createRemoteProductMirror(args: {
  remote: TibetProductService;
  broadcast(product: ProductDetail): void;
}) {
  const queues = new Map<string, Promise<void>>();

  const sync = async (candidate: ProductDetail) => {
    let latest: ProductDetail;
    try {
      latest = await args.remote.get(candidate.id);
    } catch (error) {
      logWarn("[tibet-product-mirror] remote read failed", { productId: candidate.id, error: message(error) });
      return;
    }
    if (candidate.revision === latest.revision && candidate.updatedAt === latest.updatedAt) {
      args.broadcast(latest);
      return;
    }
    if (!latest.revision) {
      logWarn("[tibet-product-mirror] missing remote revision", { productId: candidate.id });
      return;
    }
    const snapshot: ProductDetail = {
      ...latest,
      ...candidate,
      revision: latest.revision,
      planning: candidate.planning ?? latest.planning,
      updatedAt: new Date().toISOString(),
    };
    try {
      const saved = await args.remote.update(snapshot, latest.revision);
      args.broadcast(saved);
    } catch (error) {
      if (error instanceof TibetProductConflictError) {
        args.broadcast(error.latest);
      }
      logWarn("[tibet-product-mirror] remote update failed", { productId: candidate.id, error: message(error) });
    }
  };

  return {
    emit(product: ProductDetail): void {
      const previous = queues.get(product.id) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => sync(product));
      queues.set(product.id, next);
      void next.finally(() => {
        if (queues.get(product.id) === next) queues.delete(product.id);
      });
    },
  };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
