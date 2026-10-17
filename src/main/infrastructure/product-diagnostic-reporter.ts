import type { AgentSnapshot, ProductDetail } from "../../shared/contracts.js";
import type { DiagnosticEnvironment, ProductDiagnosticReport } from "../../shared/product-diagnostic-report.js";
import type { ProductTelemetryReport } from "../../shared/product-usage-report.js";
import { logWarn } from "../../shared/log-timestamp.js";
import { redactLogString } from "../../shared/log-redaction.js";
import type { AppAuthStore } from "./app-auth-store.js";
import type { VbkDatabase } from "./database/database.js";
import { resolveTibetApiBaseUrl } from "./tibet-auth.js";
import { buildProductDiagnostics } from "../application/product-diagnostic-builder.js";

export function createProductDiagnosticReporter(args: {
  db: VbkDatabase; store: AppAuthStore; environment(): DiagnosticEnvironment;
  fetchImpl?: typeof fetch; baseUrl?: string;
  now?: () => number; autoFlush?: boolean;
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
        const report = minimalReport(item.report);
        if (!report) {
          args.db.markDiagnosticSent(owner, item.eventId);
          continue;
        }
        const response = await (args.fetchImpl ?? fetch)(`${resolveTibetApiBaseUrl(args.baseUrl)}/api/extension/desktop-diagnostics`, {
          method: "POST", signal: AbortSignal.timeout(15_000),
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
          body: JSON.stringify(report),
        });
        const context = `desktop-diagnostics，HTTP ${response.status}`;
        if (!response.ok) throw new Error(`诊断服务请求失败（${context}）`);
        let envelope: { code?: number; data?: { clientId?: string; eventId?: string | null } } | null;
        try { envelope = await response.json() as typeof envelope; } catch {
          throw new Error(`诊断服务返回非 JSON 数据（${context}，${response.headers.get("content-type") ?? "未知内容类型"}）`);
        }
        if (envelope?.code !== 200 || envelope.data?.clientId !== report.clientId
          || envelope.data?.eventId !== report.issue.eventId) {
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
        const task = args.db.latestWorkflowTaskForProduct(product.id);
        for (const report of buildProductDiagnostics(product, args.environment(), snapshot, task)) {
          args.db.enqueueDiagnostic(owner, report.issue.eventId, report);
        }
        if (args.autoFlush !== false) void flush();
      } catch {
        logWarn("[product-diagnostics] collection deferred; local product remains saved");
      }
    },
    flush,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number): string {
  return redactLogString(typeof value === "string" ? value : String(value ?? "")).slice(0, max);
}

/** Rich v1 rows and old usage may still exist locally; never put those payloads on the wire. */
function minimalReport(value: ProductTelemetryReport): ProductDiagnosticReport | undefined {
  const raw = record(value);
  if (raw.reportType === "usage") return undefined;
  const legacy = record(raw.failure);
  const current = record(raw.issue);
  const issue = raw.schemaVersion === 2 ? current : legacy;
  if (!Object.keys(issue).length) return undefined;
  const state = raw.schemaVersion === 2 ? text(issue.state, 40) : "failed";
  if (!["failed", "paused", "blocked", "uncertain_write"].includes(state)) return undefined;
  const source = raw.schemaVersion === 2 && issue.source === "entry" ? "entry" : "planning";
  const reason = text(raw.schemaVersion === 2 ? issue.reason : issue.error, 2_000);
  const eventId = text(issue.eventId, 64);
  const occurredAt = text(issue.occurredAt, 40);
  if (!eventId || !reason || !occurredAt) return undefined;
  const blocker = text(issue.blockerKind, 40);
  const blockerKind = ["approval_precondition", "authorization_denied", "completion_blocked"].includes(blocker)
    ? blocker as ProductDiagnosticReport["issue"]["blockerKind"] : undefined;
  const environment = record(raw.environment);
  const optionalEnvironment = Object.fromEntries(["model", "provider"]
    .flatMap(key => environment[key] === undefined ? [] : [[key, text(environment[key], 120)]]));
  return {
    schemaVersion: 2, clientId: text(raw.clientId, 64), name: text(raw.name, 255),
    environment: { appVersion: text(environment.appVersion, 120), platform: text(environment.platform, 120),
      arch: text(environment.arch, 120), ...optionalEnvironment },
    issue: { eventId, source, state: state as ProductDiagnosticReport["issue"]["state"],
      stage: text(issue.stage || "agent", 120), reason, occurredAt, ...(blockerKind ? { blockerKind } : {}) },
  };
}
