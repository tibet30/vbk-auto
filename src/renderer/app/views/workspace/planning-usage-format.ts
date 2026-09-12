import type { ProductAiUsage } from "../../../../shared/contracts-ai-usage.js";

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1).replace(/\.0$/, "")}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest ? `${rest}s` : ""}`;
}

export function formatCost(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `¥${value.toFixed(2)}`;
}

export function formatCostLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `约 ¥${value.toFixed(2)}`;
}

export function summarizeAiUsageMetric(aiUsage: ProductAiUsage | undefined): string {
  if (!aiUsage || aiUsage.lifetime.calls === 0) return "当前产品暂无 Token 记录";
  const lifetime = aiUsage.lifetime;
  if (lifetime.tokensIncomplete || lifetime.totalTokens === null) {
    return `当前产品累计 ${formatDuration(lifetime.durationMs)} · Token 未返回`;
  }
  const parts = [`当前产品累计 ${formatTokens(lifetime.totalTokens)}`];
  const cost = formatCostLabel(lifetime.estimatedCostCny);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}
