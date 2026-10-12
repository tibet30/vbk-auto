import { createHash } from 'node:crypto';
import type { AppAuthStore } from '../infrastructure/app-auth-store.js';
import type { VbkDatabase } from '../infrastructure/database/database.js';
import { productReport, sameProductReport } from '../infrastructure/product-report.js';
import type { ProductDetail } from '../../shared/contracts.js';
import { TibetProductNotFoundError, type TibetProductService } from '../infrastructure/tibet-products.js';
import { logWarn } from '../../shared/log-timestamp.js';
import { canonicalJson } from '../../shared/product-storage-projection.js';
import { withAgentUsage } from '../agent/integration-usage.js';

/** Local snapshots are the durable retry source. Acknowledgements never replace local data. */
export function createLocalProductCloudSync(args: {
  db: VbkDatabase; store: AppAuthStore; remote: TibetProductService; now?: () => number;
}) {
  let working: Promise<void> | undefined;
  let requested = false;
  let disposed = false;
  const now = args.now ?? Date.now;
  const retries = new Map<string, { token: string; failures: number; retryAt: number }>();
  const read = (id: string) => {
    const product = args.db.getProduct(id);
    return product && withAgentUsage(product, args.db.getAgentSnapshot(id));
  };
  const drain = async () => {
    do {
      requested = false;
      const session = args.store.get();
      if (!session || disposed) return;
      const owner = session.user.id;
      const currentSession = () => args.store.get()?.user.id === owner
        && args.store.get()?.token === session.token;
      for (const id of args.db.ownedLocalProductIds(owner)) {
        if (!currentSession() || disposed) return;
        const key = `productCloudSync:${owner}:${id}`;
        const previous = retries.get(key);
        const retry = previous?.token === session.token ? previous : undefined;
        if (retry && now() < retry.retryAt) continue;
        let candidate = read(id);
        if (!candidate) continue;
        let fingerprint = cloudFingerprint(candidate);
        if (args.db.getSetting(key)?.value === fingerprint) continue;
        try {
          let saved: ProductDetail | undefined;
          try { saved = await args.remote.get(id); } catch (error) {
            // A timeout, login error or malformed response must never fall back to POST.
            if (!(error instanceof TibetProductNotFoundError)) throw error;
          }
          if (!currentSession() || disposed) return;
          // A local edit during the read takes precedence over the captured snapshot.
          candidate = read(id);
          if (!candidate) continue;
          fingerprint = cloudFingerprint(candidate);
          if (!saved) saved = await args.remote.upsert(candidate);
          if (!currentSession() || disposed) return;
          if (!read(id)) continue;
          if (saved.id !== id) throw new Error('服务端返回了不同的产品编号');
          if (!sameCloudProduct(candidate, saved)) {
            if (!saved.revision) throw new Error('服务端未返回产品版本');
            await args.remote.update(candidate, saved.revision);
          }
          if (!currentSession() || disposed) return;
          // Persist an acknowledgement only after independent server readback.
          const readback = await args.remote.get(id);
          if (!currentSession() || disposed) return;
          if (readback.id !== id || !sameCloudProduct(candidate, readback)) {
            throw new Error('完整产品同步回读不一致');
          }
          args.db.setSetting(key, fingerprint);
          retries.delete(key);
          const latest = read(id);
          if (latest && cloudFingerprint(latest) !== fingerprint) requested = true;
        } catch (error) {
          const failures = (retry?.failures ?? 0) + 1;
          const delay = Math.min(60_000 * 2 ** Math.min(failures - 1, 5), 30 * 60_000);
          retries.set(key, { token: session.token, failures, retryAt: now() + delay });
          logWarn('[product-cloud-sync] deferred upload', { productId: id, retryInSeconds: delay / 1000,
            error: error instanceof Error ? error.message : '同步失败' });
        }
      }
    } while (requested && !disposed);
  };
  const flush = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    requested = true;
    if (!working) working = drain().catch(error => {
      logWarn('[product-cloud-sync] scan deferred', { error: error instanceof Error ? error.message : '同步失败' });
    }).finally(() => {
      working = undefined;
      if (requested && !disposed) void flush();
    });
    return working;
  };
  return { flush, dispose() { disposed = true; retries.clear(); } };
}

function businessProduct(value: ProductDetail): ProductDetail {
  const { diagnostics: _diagnostics, ...product } = value.product;
  // MySQL JSON can round the last binary floating point digits on readback.
  // Only estimated AI costs receive this normalization; product prices and tokens stay exact.
  const aiUsage = value.aiUsage && JSON.parse(JSON.stringify(value.aiUsage, (key, item) =>
    key === 'estimatedCostCny' && typeof item === 'number' && Number.isFinite(item)
      ? Number(item.toPrecision(15)) : item)) as ProductDetail['aiUsage'];
  return { ...value, product, ...(aiUsage ? { aiUsage } : {}) };
}

/** The server compacts diagnostics independently; verify every business field. */
export function sameCloudProduct(left: ProductDetail, right: ProductDetail): boolean {
  return sameProductReport(businessProduct(left), businessProduct(right));
}

function cloudFingerprint(value: ProductDetail): string {
  const { updatedAt: _clock, ...report } = productReport(businessProduct(value));
  if (report.automation) {
    const { updatedAt: _runClock, ...automation } = report.automation;
    report.automation = automation;
  }
  return createHash('sha256').update(canonicalJson(report)).digest('hex');
}
