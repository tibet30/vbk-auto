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
  /** 长流程持有产品锁时，镜像只排队，不能抢先写远端。 */
  isWorkflowActive?: (productId: string) => boolean;
}) {
  const queues = new Map<string, Promise<void>>();

  const sync = async (candidate: ProductDetail) => {
    // productMutations 的本地广播可能发生在 AI / planning 尚未完成远端提交时。
    // 等主流程释放产品锁后再读远端并同步，避免旧 revision 与主流程并发写入。
    while (args.isWorkflowActive?.(candidate.id)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
      aiUsage: candidate.aiUsage ?? latest.aiUsage,
      updatedAt: new Date().toISOString(),
    };
    try {
      const saved = await args.remote.update(snapshot, latest.revision);
      args.broadcast(saved);
    } catch (error) {
      if (error instanceof TibetProductConflictError) {
        // AI 行程同步、usage flush 和 legacy local mutation 可能同时写同一产品。
        // 409 后不能只丢弃本地变更：以服务端最新 revision 为基准重放本次本地
        // mutation，同时保留服务端刚写入的 planning / aiUsage，避免旧缓存覆盖
        // 新行程状态。最多重试一次，仍冲突则交给下一次本地 mutation 继续收敛。
        try {
          const merged: ProductDetail = {
            ...error.latest,
            ...candidate,
            revision: error.latest.revision,
            planning: error.latest.planning,
            aiUsage: error.latest.aiUsage,
            updatedAt: new Date().toISOString(),
          };
          const saved = await args.remote.update(merged, error.latest.revision!);
          args.broadcast(saved);
          return;
        } catch (retryError) {
          logWarn("[tibet-product-mirror] conflict retry failed", {
            productId: candidate.id,
            error: message(retryError),
          });
        }
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
