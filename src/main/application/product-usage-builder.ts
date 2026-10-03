import { createHash } from "node:crypto";
import type { AgentSnapshot, ProductDetail } from "../../shared/contracts.js";
import type { DiagnosticEnvironment } from "../../shared/product-diagnostic-report.js";
import type { ProductUsageReport } from "../../shared/product-usage-report.js";
import { lookupAiTokenRateCny } from "../../shared/ai-usage-cost.js";
import { withAgentUsage } from "../agent/integration-usage.js";
import { appendAiUsage } from "../ai/ai-usage-merge.js";
import { redactLogString } from "../../shared/log-redaction.js";

/** Same persisted aggregate as the UI; raw events and business content stay local. */
export function buildProductUsageReport(product: ProductDetail, environment: DiagnosticEnvironment, snapshot?: AgentSnapshot): ProductUsageReport | null {
  const usage = withAgentUsage(product, snapshot).aiUsage;
  if (!usage || !usage.lifetime.calls) return null;
  const grouped = new Map<string, typeof usage.events>();
  for (const event of usage.events) {
    const key = JSON.stringify([event.model, event.provider]);
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const summary: ProductUsageReport["usage"] = {
    currency: "CNY", estimated: true, pricingBasis: "recorded-cost-or-desktop-rate",
    totals: usage.lifetime, latestRun: usage.latestRun,
    models: [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 32).map(([, events]) => ({
      model: redactLogString(events[0].model).slice(0, 120),
      provider: redactLogString(events[0].provider).slice(0, 120),
      totals: appendAiUsage(undefined, events).lifetime,
      rateCnyPerMillion: lookupAiTokenRateCny(events[0].model),
    })),
  };
  // Ignore capture time and product edits: unchanged usage is uploaded once.
  const reportId = createHash("sha256").update(JSON.stringify([product.id, summary])).digest("hex");
  return { schemaVersion: 1, reportType: "usage", reportId, clientId: product.id,
    name: redactLogString(product.name).slice(0, 255), observedAt: new Date().toISOString(), environment, usage: summary };
}
