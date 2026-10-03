import type { ProductDetail, Settings } from "../../shared/contracts.js";
import type { AppAuthStore } from "../infrastructure/app-auth-store.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { createLocalProductService } from "../infrastructure/local-product-service.js";
import { createProductDiagnosticReporter } from "../infrastructure/product-diagnostic-reporter.js";
import { createTibetProductService } from "../infrastructure/tibet-products.js";

/** One composition boundary: durable local products, independent diagnostic
 * upload, and read-only import of the previous cloud authority.
 */
export function createProductStorage(args: {
  db: VbkDatabase;
  store: AppAuthStore;
  appVersion(): string;
  settings(): Pick<Settings, "aiProvider" | "minimaxModel" | "deepseekModel">;
}) {
  const diagnostics = createProductDiagnosticReporter({ db: args.db, store: args.store,
    environment: () => {
      const settings = args.settings();
      return { appVersion: args.appVersion(), platform: process.platform, arch: process.arch,
        model: settings.aiProvider === "deepseek" ? settings.deepseekModel : settings.minimaxModel,
        provider: settings.aiProvider };
    },
  });
  const observe = (product: ProductDetail) => diagnostics.capture(product, args.db.getAgentSnapshot(product.id));
  const products = createLocalProductService({ db: args.db, store: args.store,
    legacy: createTibetProductService(args.store), capture: observe,
  });
  const timer = setInterval(() => { void diagnostics.flush(); }, 60_000);
  timer.unref();
  void diagnostics.flush();
  return { products, observe, dispose: () => clearInterval(timer) };
}
