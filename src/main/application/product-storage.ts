import type { ProductDetail, Settings } from "../../shared/contracts.js";
import type { AppAuthStore } from "../infrastructure/app-auth-store.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { createLocalProductService } from "../infrastructure/local-product-service.js";
import { createProductDiagnosticReporter } from "../infrastructure/product-diagnostic-reporter.js";

/** Durable local products plus minimal abnormal-stop reporting. */
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
  const observe = (product: ProductDetail) => {
    diagnostics.capture(product, args.db.getAgentSnapshot(product.id));
  };
  const products = createLocalProductService({ db: args.db, store: args.store, capture: observe });
  const timer = backgroundSyncEnabled
    ? setInterval(() => { void diagnostics.flush(); }, 60_000)
    : undefined;
  timer?.unref();
  if (backgroundSyncEnabled) {
    void diagnostics.flush();
  }
  return { products, observe, dispose: () => { if (timer) clearInterval(timer); } };
}
