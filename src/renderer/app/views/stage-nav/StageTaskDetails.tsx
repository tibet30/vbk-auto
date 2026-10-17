import { type ReactNode, useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { WorkflowTaskStrip } from "../workflow-task/TaskStrip";
import { PlanningUsagePanel, usePlanningUsage } from "../workspace/planning-usage";
import styles from "./StageNav.module.less";

export function StageTaskDetails({ model, children }: { model: AppModel; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const { product, currentWorkflowTask: task, vbkStageStatus } = model;
  const usage = usePlanningUsage(product?.aiUsage);
  const reviewLabel = model.reviewStepStatus === "passed"
    ? `就绪 ${model.readiness.completion}% · 可以进入录入`
    : model.reviewStepStatus === "reviewing"
      ? `${model.readiness.completion}% · 等待 AI 回复`
      : `还差 ${model.readiness.issues.length} 项 · 尚未就绪`;
  return <details className={styles.taskDetails} ref={details}>
    <summary id="workflow-task-status" aria-label="查看当前状态与任务详情">
      <span className={styles.taskDetailsStatus} role="status" aria-live="polite" aria-atomic="true">{children}</span>
      <ChevronDown className={styles.taskDetailsChevron} size={12} aria-hidden="true" />
    </summary>
    <div id="workflow-task-details-popover" className={styles.detailsBody}>
      <p><span>方案审查：{reviewLabel}</span><span>VBK 录入：{vbkStageStatus.label} · {vbkStageStatus.detail}</span></p>
      <WorkflowTaskStrip task={task} statusId="workflow-task-details-status" detailed />
      {usage.visible && <p className={styles.usageLabel}>{usage.label}</p>}
      {usage.visible && product?.aiUsage && <PlanningUsagePanel aiUsage={product.aiUsage} recent={usage.recent} onClose={() => { if (details.current) details.current.open = false; }} />}
    </div>
  </details>;
}
