import type { ProductDetail, Settings } from "../../shared/contracts.js";
import type { AppAuthStore } from "../infrastructure/app-auth-store.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { createLocalProductService } from "../infrastructure/local-product-service.js";
import { createProductDiagnosticReporter } from "../infrastructure/product-diagnostic-reporter.js";
import { createLocalProductCloudSync } from "./local-product-cloud-sync.js";
import { createTibetProductService } from "../infrastructure/tibet-products.js";

/** One composition boundary: durable local products, independent diagnostic
 * upload, full cloud replication, and import of historical cloud products.
 */
export function createProductStorage(args: {
  db: VbkDatabase;
  store: AppAuthStore;
  appVersion(): string;
  settings(): Pick<Settings, "aiProvider" | "minimaxModel" | "deepseekModel">;
  /** Explicit safe startup keeps all provider replication and diagnostics local. */
  enableBackgroundSync?: boolean;
}) {
  const backgroundSyncEnabled = args.enableBackgroundSync !== false;
  const diagnostics = createProductDiagnosticReporter({ db: args.db, store: args.store,
    environment: () => {
      const settings = args.settings();
      return { appVersion: args.appVersion(), platform: process.platform, arch: process.arch,
        model: settings.aiProvider === "deepseek" ? settings.deepseekModel : settings.minimaxModel,
        provider: settings.aiProvider };
    }, autoFlush: backgroundSyncEnabled,
  });
  const remote = createTibetProductService(args.store);
  const cloud = createLocalProductCloudSync({ db: args.db, store: args.store, remote });
  const observe = (product: ProductDetail) => {
    diagnostics.capture(product, args.db.getAgentSnapshot(product.id));
    if (backgroundSyncEnabled) void cloud.flush();
  };
  const products = createLocalProductService({ db: args.db, store: args.store,
    legacy: backgroundSyncEnabled ? remote : undefined, capture: observe,
  });
  const timer = backgroundSyncEnabled
    ? setInterval(() => { void diagnostics.flush(); void cloud.flush(); }, 60_000)
    : undefined;
  timer?.unref();
  if (backgroundSyncEnabled) {
    void diagnostics.flush();
    void cloud.flush();
  }
  return { products, observe, dispose: () => { if (timer) clearInterval(timer); cloud.dispose(); } };
}
