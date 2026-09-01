import { logWarn } from "../../shared/log-timestamp.js";
import type { ProductDetail } from "../../shared/contracts.js";
import { TibetProductConflictError, type TibetProductService } from "../infrastructure/tibet-products.js";

/**
 * Serialises legacy local mutations into Tibet. SQLite remains an operational
 * cache for automation code. Business snapshots are broadcast after the remote
 * revisioned PATCH succeeds; explicitly allow-listed local runtime progress may
 * be broadcast while its workflow lock is held, then converges to the remotely
 * saved snapshot after release.
 */
export function createRemoteProductMirror(args: {
  remote: TibetProductService;
  broadcast(product: ProductDetail): void;
  /** 长流程持有产品锁时，镜像只排队，不能抢先写远端。 */
  isWorkflowActive?: (productId: string) => boolean;
  /**
   * 自动录入的阶段状态属于本机运行态：远端同步仍需等待产品锁释放，但 UI
   * 不能因此等到整轮结束才看到进展。仅由调用方对白名单工作流开启即时广播。
   */
  shouldBroadcastWhileActive?: (productId: string) => boolean;
}) {
  // emit() always receives a complete ProductDetail snapshot, so replacing an
  // older pending value is safe and preserves the newest runtime state.
  const pending = new Map<string, ProductDetail>();
  const workers = new Map<string, Promise<void>>();

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

  const drain = async (productId: string) => {
    // productMutations 的本地广播可能发生在 AI / planning 尚未完成远端提交时。
    // 等主流程释放产品锁后再读远端并同步，避免旧 revision 与主流程并发写入。
    while (pending.has(productId)) {
      while (args.isWorkflowActive?.(productId)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // 长流程中同一产品会产生许多阶段快照。解锁时只写最后一份，避免在
      // UI 已经实时前进后又从远端连续回放过期的中间状态。
      const candidate = pending.get(productId);
      if (!candidate) continue;
      pending.delete(productId);
      await sync(candidate);
    }
  };

  const ensureWorker = (productId: string) => {
    if (workers.has(productId)) return;
    const worker = drain(productId);
    workers.set(productId, worker);
    void worker.finally(() => {
      if (workers.get(productId) !== worker) return;
      workers.delete(productId);
      // sync 结束和 finally 之间若刚好收到新快照，继续启动 drain。
      if (pending.has(productId)) ensureWorker(productId);
    });
  };

  return {
    emit(product: ProductDetail): void {
      pending.set(product.id, product);
      if (args.isWorkflowActive?.(product.id) && args.shouldBroadcastWhileActive?.(product.id)) {
        args.broadcast(product);
      }
      ensureWorker(product.id);
    },
  };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
