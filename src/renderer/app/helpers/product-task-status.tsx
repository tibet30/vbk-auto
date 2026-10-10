import { AlertTriangle, Check, LoaderCircle, Sparkles } from "lucide-react";
import type { ProductSummary, ProductWorkflowTaskStatus } from "../../../shared/contracts.js";
import { replacementDraftProductId } from "../../../shared/product-replacement.js";
import styles from "./components.module.less";

/** 已保存草稿显示产品结果；交通等后台任务仍由列表独立的任务行说明。 */
export function ProductStatusBadge({ item }: { item: ProductSummary }) {
  if (item.status === "draft_saved") {
    return <span className={styles.productBadge} data-state="draft_saved"><Check size={11} aria-hidden="true" />{item.coverNeedsReplacement ? "草稿已存 · 需换图" : "草稿已保存"}</span>;
  }
  const task = item.workflowTask;
  if (task?.status === "queued") return <span className={styles.productBadge} data-state="planning"><Clock3Small />任务排队中</span>;
  if (task?.status === "running") return <span className={styles.productBadge} data-state="automating"><LoaderCircle size={11} aria-hidden="true" />后台执行中</span>;
  if (task?.status === "needs_attention") return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />任务待处理</span>;
  if (task?.status === "failed") return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />任务失败</span>;
  if (isProductSupersededByReplacement(item)) {
    return <span className={styles.productBadge} data-state="draft_saved"><Check size={11} aria-hidden="true" />已由新草稿接管</span>;
  }
  switch (item.status) {
    case "planning":
      return <span className={styles.productBadge} data-state="planning"><Sparkles size={11} aria-hidden="true" />方案规划中</span>;
    case "review":
      return <span className={styles.productBadge} data-state="review"><CircleHelpSmall />{item.coverNeedsReplacement ? "待录入草稿 · 禁止上架" : "等待确认"}</span>;
    case "automating":
      return <span className={styles.productBadge} data-state="automating"><LoaderCircle size={11} aria-hidden="true" />正在录入</span>;
    case "blocked":
      return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />需要处理</span>;
  }
}

/**
 * 旧远端壳无权访问时，不能伪造它已保存；但已有可读回的新草稿接管后，
 * 列表不应再把历史记录误报成待处理。任务文案包含替代产品 ID，供用户追溯。
 */
export function isProductSupersededByReplacement(item: ProductSummary): boolean {
  return item.workflowTask?.status === "succeeded" && Boolean(replacementDraftProductId(item));
}

export function productTaskStageLabel(
  stage: NonNullable<ProductSummary["workflowTask"]>["stage"],
  status?: ProductWorkflowTaskStatus,
): string {
  if (status === "abandoned") return "已废弃";
  if (stage === "planning") return "方案规划";
  if (stage === "readiness") return "录入前核验";
  if (stage === "automation") return "携程录入";
  if (stage === "completed") return "全部完成";
  return "等待执行";
}

function Clock3Small() {
  return <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}

function CircleHelpSmall() {
  return <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2-2.4 3.4" /><path d="M12 17h.01" /></svg>;
}
