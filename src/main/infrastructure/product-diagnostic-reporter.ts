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
  now?: () => number;
}) {
  let working: Promise<void> | undefined;
  const now = args.now ?? Date.now;
  const retries = new Map<number, { token: string; failures: number; retryAt: number; error: string; loggedAt: number }>();
  const flush = (): Promise<void> => {
    if (working) return working;
    const session = args.store.get();
    if (!session) return Promise.resolve();
    const previous = retries.get(session.user.id);
    const retry = previous?.token === session.token ? previous : undefined;
    if (retry && now() < retry.retryAt) return Promise.resolve();
    working = drain(session.user.id).then(() => {
      retries.delete(session.user.id);
    }).catch(error => {
      const message = error instanceof Error ? error.message : "上传失败";
      const failures = (retry?.failures ?? 0) + 1;
      const delay = Math.min(60_000 * 2 ** Math.min(failures - 1, 5), 30 * 60_000);
      const timestamp = now();
      const shouldLog = !retry || retry.error !== message || timestamp - retry.loggedAt >= 30 * 60_000;
      retries.set(session.user.id, { token: session.token, failures, retryAt: timestamp + delay,
        error: message, loggedAt: shouldLog ? timestamp : retry.loggedAt });
      if (shouldLog) logWarn("[product-diagnostics] deferred upload", { error: message, retryInSeconds: delay / 1000 });
    }).finally(() => { working = undefined; });
    return working;
  };
  const drain = async (owner: number) => {
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
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
          body: JSON.stringify(item.report),
        });
        const context = `${route}，HTTP ${response.status}`;
        if (!response.ok) throw new Error(`诊断服务请求失败（${context}）`);
        let envelope: { code?: number; data?: { clientId?: string; eventId?: string | null } } | null;
        try { envelope = await response.json() as typeof envelope; } catch {
          throw new Error(`诊断服务返回非 JSON 数据（${context}，${response.headers.get("content-type") ?? "未知内容类型"}）`);
        }
        if (envelope?.code !== 200 || envelope.data?.clientId !== item.report.clientId
          || envelope.data?.eventId !== expectedEventId) {
          throw new Error(`诊断服务未确认保存（${context}）`);
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
