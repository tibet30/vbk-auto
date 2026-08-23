import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ProductAiUsage } from "../../../../shared/contracts-ai-usage.js";
import styles from "./planning-usage.module.less";

const SOURCE_LABELS: Record<string, string> = {
  "planning.generateStage": "阶段生成",
  "planning.structureLocation": "地点结构化",
  "planning.recommendSpotNames": "景点池",
  "planning.composeItinerary": "行程编排",
  "planning.estimateVehicleCost": "用车估价",
  "planning.resolvePoiName": "POI 纠正",
  "chat.reply": "对话微调",
  "chat.regenerate": "字段重生成",
  "automation.disambiguate": "下拉消歧",
  "automation.diagnose": "录入诊断",
};

function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1).replace(/\.0$/, "")}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest ? `${rest}s` : ""}`;
}

function formatCost(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `¥${value.toFixed(2)}`;
}

function formatCostLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `约 ¥${value.toFixed(2)}`;
}

export function summarizeAiUsageMetric(aiUsage: ProductAiUsage | undefined): string {
  if (!aiUsage || aiUsage.lifetime.calls === 0) return "本产品暂无 Token 记录";
  const lifetime = aiUsage.lifetime;
  const latest = aiUsage.latestRun;
  if (lifetime.tokensIncomplete || lifetime.totalTokens === null) {
    return `本产品 ${formatDuration(lifetime.durationMs)} · Token 未返回`;
  }
  const parts = [`本产品 ${formatTokens(lifetime.totalTokens)}`];
  if (latest.totalTokens !== null && latest.runId) {
    parts.push(`上次 ${formatTokens(latest.totalTokens)}`);
  }
  const cost = formatCostLabel(lifetime.estimatedCostCny);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

export function usePlanningUsage(aiUsage: ProductAiUsage | undefined) {
  const [open, setOpen] = useState(false);
  const label = useMemo(() => summarizeAiUsageMetric(aiUsage), [aiUsage]);
  const recent = useMemo(
    () => [...(aiUsage?.events ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20),
    [aiUsage?.events],
  );
  const visible = Boolean(aiUsage && aiUsage.lifetime.calls > 0);
  return { open, setOpen, label, recent, visible, aiUsage };
}

export function PlanningUsageToggle(props: {
  label: string;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className={styles.metric}
      aria-expanded={props.open}
      title={props.label}
      onClick={props.onToggle}
    >
      <span className={styles.metricText}>{props.label}</span>
    </button>
  );
}

function UsageTableHeader() {
  return (
    <div className={`${styles.row} ${styles.rowHeader}`} role="row">
      <span className={styles.name}>项目</span>
      <span className={styles.num}>次数</span>
      <span className={styles.num}>耗时</span>
      <span className={styles.num}>入</span>
      <span className={styles.num}>出</span>
      <span className={styles.num}>费用</span>
    </div>
  );
}

export function PlanningUsagePanel(props: {
  aiUsage: ProductAiUsage;
  recent: ProductAiUsage["events"];
  onClose(): void;
}) {
  const { aiUsage, recent, onClose } = props;
  return (
    <div className={styles.panel} role="region" aria-label="AI Token 消耗明细">
      <div className={styles.panelHead}>
        <button
          type="button"
          className={styles.panelTitle}
          aria-expanded={true}
          aria-label="收起 AI Token 消耗"
          onClick={onClose}
        >
          <span className={styles.panelTitleChevron} aria-hidden="true">
            <ChevronDown size={14} />
          </span>
          AI Token 消耗
        </button>
      </div>
      <div className={styles.panelBody}>
        <p className={styles.sectionLabel}>按阶段</p>
        {aiUsage.byStage.length > 0 ? (
          <div className={styles.table} role="table" aria-label="按阶段 Token 汇总">
            <UsageTableHeader />
            {aiUsage.byStage.map((row) => (
              <div className={styles.row} role="row" key={row.stage}>
                <span className={styles.name} title={SOURCE_LABELS[row.stage] || row.stage}>
                  {SOURCE_LABELS[row.stage] || row.stage}
                </span>
                <span className={styles.num}>{row.totals.calls}</span>
                <span className={styles.num}>{formatDuration(row.totals.durationMs)}</span>
                <span className={styles.num}>{formatTokens(row.totals.inputTokens)}</span>
                <span className={styles.num}>{formatTokens(row.totals.outputTokens)}</span>
                <span className={styles.num}>{formatCost(row.totals.estimatedCostCny)}</span>
              </div>
            ))}
          </div>
        ) : <p className={styles.empty}>暂无阶段汇总</p>}

        <p className={styles.sectionLabel}>最近调用</p>
        {recent.length > 0 ? (
          <div className={styles.table} role="table" aria-label="最近 AI 调用">
            <UsageTableHeader />
            {recent.map((event) => {
              const base = `${SOURCE_LABELS[event.source] || event.source}${event.stage ? ` · ${event.stage}` : ""}`;
              const name = event.status === "error" && event.errorCode ? `${base}（${event.errorCode}）` : base;
              return (
                <div className={styles.row} role="row" key={event.id} data-status={event.status}>
                  <span className={styles.name} title={name}>{name}</span>
                  <span className={styles.num}>{event.status === "error" ? "—" : "1"}</span>
                  <span className={styles.num}>{formatDuration(event.durationMs)}</span>
                  <span className={styles.num}>{formatTokens(event.inputTokens)}</span>
                  <span className={styles.num}>{formatTokens(event.outputTokens)}</span>
                  <span className={styles.num}>{formatCost(event.estimatedCostCny)}</span>
                </div>
              );
            })}
          </div>
        ) : <p className={styles.empty}>暂无调用明细</p>}
      </div>
    </div>
  );
}
