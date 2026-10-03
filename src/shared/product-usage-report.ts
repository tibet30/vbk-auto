import type { AiUsageTotals } from "./contracts-ai-usage.js";
import type { AiTokenRateCny } from "./ai-usage-cost.js";
import type { DiagnosticEnvironment, ProductDiagnosticReport } from "./product-diagnostic-report.js";

export interface ProductUsageReport {
  schemaVersion: 1;
  reportType: "usage";
  reportId: string;
  clientId: string;
  name: string;
  observedAt: string;
  environment: DiagnosticEnvironment;
  usage: {
    currency: "CNY";
    estimated: true;
    pricingBasis: "recorded-cost-or-desktop-rate";
    totals: AiUsageTotals;
    latestRun: AiUsageTotals & { runId?: string };
    models: Array<{ model: string; provider: string; totals: AiUsageTotals; rateCnyPerMillion: AiTokenRateCny | null }>;
  };
}

export type ProductTelemetryReport = ProductDiagnosticReport | ProductUsageReport;
