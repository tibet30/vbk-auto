import type { AgentSnapshot, ProductDetail } from "../../shared/contracts.js";
import type { DiagnosticEnvironment } from "../../shared/product-diagnostic-report.js";
import { logWarn } from "../../shared/log-timestamp.js";
import type { AppAuthStore } from "./app-auth-store.js";
import type { VbkDatabase } from "./database/database.js";
import { resolveTibetApiBaseUrl } from "./tibet-auth.js";
import { buildProductDiagnostics } from "../application/product-diagnostic-builder.js";
import { buildProductUsageReport } from "../application/product-usage-builder.js";

export function createProductDiagnosticReporter(args: {
  db: VbkDatabase; store: AppAuthStore; environment(): DiagnosticEnvironment;
  fetchImpl?: typeof fetch; baseUrl?: string;
}) {
  let working: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (working) return working;
    working = drain().catch(error => {
      logWarn("[product-diagnostics] deferred upload", { error: error instanceof Error ? error.message : "上传失败" });
    }).finally(() => { working = undefined; });
    return working;
  };
  const drain = async () => {
    const owner = args.store.get()?.user.id;
    if (!owner) return;
    while (true) {
      const pending = args.db.pendingDiagnostics(owner);
      if (!pending.length) return;
      for (const item of pending) {
        const session = args.store.get();
        if (!session || session.user.id !== owner) return;
        const usage = "reportType" in item.report && item.report.reportType === "usage";
        const route = usage ? "desktop-usage" : "desktop-diagnostics";
        const expectedEventId = "reportId" in item.report ? item.report.reportId : item.report.failure?.eventId ?? null;
        const response = await (args.fetchImpl ?? fetch)(`${resolveTibetApiBaseUrl(args.baseUrl)}/api/extension/${route}`, {
          method: "POST", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
          body: JSON.stringify(item.report),
        });
        const envelope = await response.json() as { code?: number; data?: { clientId?: string; eventId?: string | null } };
        if (!response.ok || envelope.code !== 200 || envelope.data?.clientId !== item.report.clientId
          || envelope.data?.eventId !== expectedEventId) {
          throw new Error(`诊断服务未确认保存（HTTP ${response.status}）`);
        }
        args.db.markDiagnosticSent(owner, item.eventId);
      }
    }
  };
  return {
    capture(product: ProductDetail, snapshot?: AgentSnapshot): void {
      try {
        const owner = args.db.readLocalProductState(product.id)?.ownerUserId;
        if (!owner) return;
        for (const report of buildProductDiagnostics(product, args.environment(), snapshot)) {
          args.db.enqueueDiagnostic(owner, report.failure?.eventId ?? `created:${product.id}`, report);
        }
        const usage = buildProductUsageReport(product, args.environment(), snapshot);
        if (usage) args.db.enqueueDiagnostic(owner, `usage:${usage.reportId}`, usage);
        void flush();
      } catch {
        logWarn("[product-diagnostics] collection deferred; local product remains saved");
      }
    },
    flush,
  };
}
