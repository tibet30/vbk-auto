import { AlertTriangle, Check, LoaderCircle, Sparkles } from "lucide-react";
import type { ProductSummary, ProductWorkflowTaskStatus } from "../../../shared/contracts.js";
import styles from "./components.module.less";

/** 产品业务状态与后台任务状态共用一枚入口徽章；运行任务优先于静态产品状态。 */
export function ProductStatusBadge({ item }: { item: ProductSummary }) {
  const task = item.workflowTask;
  if (task?.status === "queued") return <span className={styles.productBadge} data-state="planning"><Clock3Small />任务排队中</span>;
  if (task?.status === "running") return <span className={styles.productBadge} data-state="automating"><LoaderCircle size={11} aria-hidden="true" />后台执行中</span>;
  if (task?.status === "needs_attention") return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />任务待处理</span>;
  if (task?.status === "failed") return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />任务失败</span>;
  switch (item.status) {
    case "planning":
      return <span className={styles.productBadge} data-state="planning"><Sparkles size={11} aria-hidden="true" />方案规划中</span>;
    case "review":
      return <span className={styles.productBadge} data-state="review"><CircleHelpSmall />等待确认</span>;
    case "automating":
      return <span className={styles.productBadge} data-state="automating"><LoaderCircle size={11} aria-hidden="true" />正在录入</span>;
    case "draft_saved":
      return <span className={styles.productBadge} data-state="draft_saved"><Check size={11} aria-hidden="true" />草稿已保存</span>;
    case "blocked":
      return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />需要处理</span>;
  }
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
